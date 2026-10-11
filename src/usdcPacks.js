// Pro tier: buy packs of TG Finder lookups with USDC on Base (Base Pay).
//
//   GET  /api/usdc/packs   — what's for sale, this user's balance, whether they can buy
//   POST /api/usdc/order   — reserve an order; returns the EXACT amount to pay (price + tiny order code)
//   POST /api/usdc/claim   — after the user paid via Base Pay: verify onchain, grant credits once
//
// Security model (the browser's "payment succeeded" is never trusted):
//  * Order code — each order gets a unique amount (e.g. 10.003417). Transaction ids are public onchain,
//    so without this anyone could claim someone else's payment. Only the order whose exact amount was paid matches.
//    An amount is never reissued for 24h, even after its order was replaced or expired, so a late payment can
//    only ever belong to the user who opened that order.
//  * Retrying is always possible — starting a new order replaces the user's older unpaid ones. A replaced/expired
//    order can still be claimed for 24h (they may have paid and closed the tab).
//  * Server verification — getPaymentStatus() checks the sender's USDC transfer to OUR address for the EXACT amount.
//  * Replay protection — usdc_orders.tx_hash is UNIQUE; an order flips pending→paid atomically.
//  * Grant-once lock — credits_granted_at is set atomically before credits are added.
// All purchases are final — no refunds (shown before payment and on the receipt).

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fromMicro, toMicro, FINAL_SALE_NOTICE } from './config.js';

// Base Pay's browser bundle, served from our own pinned node_modules rather than a
// third-party CDN — no extra script origin on the page that takes people's money.
const SDK_FILE = (() => {
  try { return path.join(path.dirname(createRequire(import.meta.url).resolve('@base-org/account')), 'base-account.min.js'); }
  catch { return null; }   // package missing -> /vendor/base-account.min.js simply 404s, nothing else is affected
})();

const PAYMENT_ID_RE = /^0x[0-9a-fA-F]{64}$/;      // Base Pay "id" = ERC-4337 userOp hash
const CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;     // an unpaid order can still be claimed this long after it was opened
const MAX_ORDERS_PER_HOUR = 10;                  // spam guard (replaces a cap on open orders, which locked real users out)
const UNPAID = ['pending', 'superseded', 'expired'];

const tierOf = user => user?.subscription_tier || 'free';
const isBdBrain = t => t === 'bd_brain' || t === 'ai_power';
const isPro = t => t === 'pro' || t === 'ai';

export function mountUsdcPacks(app, deps) {
  const { config, supabase, requireAuthJwtOnly, sendBotMsg, openAppButton, logEvent, alertAdmin = async () => {}, log = console } = deps;
  const cfg = config.packs;
  const net = cfg.network;

  const off = (req, res) => res.status(503).json({ error: 'usdc_unavailable', message: 'USDC purchases are not enabled on this server.' });
  if (!cfg.enabled || !supabase) {
    log.warn('[usdc] disabled — needs USDC_PAY_TO (or X402_PAY_TO) and Supabase');
    app.get('/api/usdc/packs', requireAuthJwtOnly, (req, res) => res.json({ enabled: false }));
    app.post('/api/usdc/order', requireAuthJwtOnly, off);
    app.post('/api/usdc/claim', requireAuthJwtOnly, off);
    return;
  }

  app.get('/vendor/base-account.min.js', (req, res) => {
    if (!SDK_FILE) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400').type('application/javascript').sendFile(SDK_FILE, err => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  const getUser = async tid => (await supabase.from('users')
    .select('subscription_tier, tg_finder_credits, tg_finder_pro_used, bot_chat_id').eq('telegram_id', tid).maybeSingle()).data;

  const publicPacks = () => cfg.items.map(p => ({ id: p.id, lookups: p.lookups, price_usdc: p.priceUsdc }));

  // Optimistic-concurrency increment (supabase-js has no atomic increment without an RPC).
  async function addCredits(tid, n) {
    for (let i = 0; i < 6; i++) {
      const { data: u } = await supabase.from('users').select('tg_finder_credits').eq('telegram_id', tid).maybeSingle();
      if (!u) throw new Error('user not found');
      const current = u.tg_finder_credits || 0;
      const { data: upd } = await supabase.from('users').update({ tg_finder_credits: current + n })
        .eq('telegram_id', tid).eq('tg_finder_credits', current).select('tg_finder_credits');
      if (upd?.length) return upd[0].tg_finder_credits;
    }
    throw new Error('could not update credits (contention)');
  }

  app.get('/api/usdc/packs', requireAuthJwtOnly, async (req, res) => {
    const tid = parseInt(req.telegramId);
    const user = await getUser(tid);
    const tier = tierOf(user);
    res.json({
      enabled: true,
      network: net.label, testnet: net.testnet, to: cfg.payTo, explorer: net.explorer,
      packs: publicPacks(),
      credits: user?.tg_finder_credits || 0,
      free_available: isPro(tier) && user?.tg_finder_pro_used !== true,   // the free lookup is spent before purchased credits
      tier,
      can_buy: isPro(tier),
      reason: isPro(tier) ? null : isBdBrain(tier) ? 'bd_brain_unlimited' : 'pro_required',
      notice: FINAL_SALE_NOTICE,
    });
  });

  app.post('/api/usdc/order', requireAuthJwtOnly, async (req, res) => {
    const tid = parseInt(req.telegramId);
    const pack = cfg.items.find(p => p.id === req.body?.pack);
    if (!pack) return res.status(400).json({ error: 'unknown_pack' });
    if (req.body?.accepted_final_sale !== true) {
      return res.status(400).json({ error: 'terms_required', message: `Please confirm: ${FINAL_SALE_NOTICE}` });
    }

    const user = await getUser(tid);
    const tier = tierOf(user);
    if (isBdBrain(tier)) return res.status(400).json({ error: 'bd_brain_unlimited', message: 'BD Brain already includes unlimited TG Finder lookups.' });
    if (!isPro(tier))    return res.status(403).json({ error: 'pro_required', message: 'Lookup packs are available on the Pro plan.' });

    const dayAgo = new Date(Date.now() - CLAIM_WINDOW_MS).toISOString();
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();

    const { count: recent } = await supabase.from('usdc_orders').select('id', { count: 'exact', head: true })
      .eq('telegram_id', tid).gte('created_at', hourAgo);
    if ((recent || 0) >= MAX_ORDERS_PER_HOUR) {
      return res.status(429).json({ error: 'too_many_orders', message: 'Too many purchase attempts in the last hour — please try again in a little while.' });
    }

    // Starting a fresh checkout replaces this user's older unpaid orders, so closing the wallet window never locks anyone out.
    await supabase.from('usdc_orders').update({ status: 'superseded' }).eq('telegram_id', tid).eq('status', 'pending');

    // Unique amount: price + 0.000001…0.009999 USDC order code, never one used by ANY unpaid order in the last 24h
    // (those can still be claimed late, so their amounts must keep pointing at exactly one user).
    const base = toMicro(pack.priceUsdc);
    let amount = null;
    for (let i = 0; i < 25 && !amount; i++) {
      const candidate = fromMicro(base + BigInt(crypto.randomInt(1, 10000)));
      const { count: clash } = await supabase.from('usdc_orders').select('id', { count: 'exact', head: true })
        .eq('amount_usdc', candidate).in('status', UNPAID).gte('created_at', dayAgo);
      if (!clash) amount = candidate;
    }
    if (!amount) return res.status(503).json({ error: 'busy', message: 'Please try again in a moment.' });

    const { data: order, error } = await supabase.from('usdc_orders').insert({
      telegram_id: tid, pack: pack.id, credits: pack.lookups, amount_usdc: amount, network: cfg.networkKey, status: 'pending',
    }).select('id').single();
    if (error) { log.error('[usdc] order insert failed:', error.message); return res.status(500).json({ error: 'order_failed' }); }

    logEvent(tid, 'usdc_order_created', { order_id: order.id, pack: pack.id, amount, network: cfg.networkKey, accepted_final_sale: true });
    res.json({
      order_id: order.id, amount, to: cfg.payTo, testnet: net.testnet, network: net.label,
      lookups: pack.lookups, notice: FINAL_SALE_NOTICE,
    });
  });

  app.post('/api/usdc/claim', requireAuthJwtOnly, async (req, res) => {
    const tid = parseInt(req.telegramId);
    const orderId = parseInt(req.body?.order_id);
    const paymentId = String(req.body?.payment_id || '');
    if (!orderId || !PAYMENT_ID_RE.test(paymentId)) return res.status(400).json({ error: 'bad_request' });

    const { data: order } = await supabase.from('usdc_orders').select('*').eq('id', orderId).eq('telegram_id', tid).maybeSingle();
    if (!order) return res.status(404).json({ error: 'order_not_found' });

    // Idempotent: a paid order claimed again just reports the balance.
    if (order.status === 'paid') {
      if (order.tx_hash?.toLowerCase() !== paymentId.toLowerCase()) return res.status(409).json({ error: 'order_already_paid' });
      return res.json({ ok: true, already: true, credits: (await getUser(tid))?.tg_finder_credits || 0 });
    }
    // Replaced/expired orders stay claimable for 24h (the user may have paid and then closed the tab).
    if (!UNPAID.includes(order.status) || Date.now() - new Date(order.created_at).getTime() > CLAIM_WINDOW_MS) {
      return res.status(410).json({ error: 'order_expired', message: 'This order is too old to claim automatically. If you were charged, contact support with your payment id.' });
    }

    // ── Verify onchain: sender → OUR address, EXACT amount ──
    let verdict;
    try {
      const getPaymentStatus = deps.getPaymentStatus || (await import('@base-org/account')).getPaymentStatus;
      verdict = await getPaymentStatus({
        id: paymentId,
        testnet: net.testnet,
        telemetry: false,
        expectedPayment: { amount: fromMicro(Math.round(Number(order.amount_usdc) * 1e6)), recipient: cfg.payTo },
      });
    } catch (err) {
      const msg = String(err?.message || err);
      // Mismatches are final; anything else (RPC hiccup, bundler lag) is retryable.
      if (/does not match|Unable to find USDC transfer|multiple USDC transfers|must be greater than zero/.test(msg)) {
        log.warn(`[usdc] order ${orderId} payment mismatch: ${msg}`);
        return res.status(400).json({ error: 'payment_mismatch', message: 'That payment does not match this order.' });
      }
      log.warn(`[usdc] order ${orderId} verification hiccup: ${msg}`);
      return res.status(202).json({ status: 'pending' });
    }
    if (verdict.status === 'pending' || verdict.status === 'not_found') return res.status(202).json({ status: 'pending' });
    if (verdict.status !== 'completed') return res.status(400).json({ error: 'payment_failed', message: verdict.reason || 'The payment did not complete.' });

    // ── unpaid → paid, atomically; tx_hash UNIQUE blocks reusing one payment for two orders ──
    const { data: flipped, error: flipErr } = await supabase.from('usdc_orders')
      .update({ status: 'paid', tx_hash: paymentId.toLowerCase(), payer: verdict.sender, paid_at: new Date().toISOString() })
      .eq('id', orderId).in('status', UNPAID).select('id');
    if (flipErr) {
      if (flipErr.code === '23505') return res.status(409).json({ error: 'payment_already_used' });
      log.error('[usdc] order flip failed:', flipErr.message);
      return res.status(500).json({ error: 'claim_failed' });
    }
    if (!flipped?.length) return res.json({ ok: true, already: true, credits: (await getUser(tid))?.tg_finder_credits || 0 }); // a concurrent claim won

    // ── grant exactly once: take the lock first, then add credits ──
    const { data: lock } = await supabase.from('usdc_orders').update({ credits_granted_at: new Date().toISOString() })
      .eq('id', orderId).is('credits_granted_at', null).select('id');
    if (!lock?.length) return res.json({ ok: true, already: true, credits: (await getUser(tid))?.tg_finder_credits || 0 });

    let balance;
    try {
      balance = await addCredits(tid, order.credits);
    } catch (err) {
      await supabase.from('usdc_orders').update({ credits_granted_at: null }).eq('id', orderId);   // allow a retry
      log.error(`[usdc] CREDIT GRANT FAILED order ${orderId} user ${tid}:`, err.message);
      alertAdmin(`🚨 USDC order ${orderId} PAID but credits not granted for user ${tid} (${order.credits} lookups). Payment ${paymentId}.`).catch(() => {});
      return res.status(500).json({ error: 'grant_failed', message: 'Your payment was received but crediting failed. Tap "Claim" again in a minute — or contact support. You will not be charged twice.' });
    }

    logEvent(tid, 'usdc_pack_purchased', { order_id: orderId, credits_added: order.credits, amount: String(order.amount_usdc), network: cfg.networkKey, payment_id: paymentId, payer: verdict.sender });
    const user = await getUser(tid);
    if (user?.bot_chat_id) {
      sendBotMsg(user.bot_chat_id,
        `✅ Payment received — +${order.credits} TG Finder lookups.\nBalance: ${balance} lookups.\n\n${FINAL_SALE_NOTICE}`,
        openAppButton('🔍 Open TG Finder')).catch(() => {});
    }
    res.json({ ok: true, credits: balance, added: order.credits });
  });
}
