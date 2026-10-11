// Agent-payable TG Finder lookup — x402 on Base.
//
// Any AI agent (or script) can POST a company domain / X profile to
//   POST /x402/tg-finder/lookup
// get an HTTP 402 "payment required" answer, pay in USDC on Base, and receive the
// Telegram handles + X profiles + websites TG Finder finds — no signup, no API key.
// Payment is verified and settled onchain by Coinbase's CDP facilitator.
//
// Flow (x402 "authorization" flow): verify payment → run handler → settle ONLY if the
// handler succeeded (status < 400). A failed lookup is therefore never charged.
//   1. POST /x402/tg-finder/lookup   (paid)  → { search_id, poll_url }   — starts the TG Finder search
//   2. GET  /x402/tg-finder/result?token=…   (free, token-gated) → progress, then the result
//
// Safety:
//  * Fails closed — the paid route answers 503 until the x402 middleware is ready; the handler is
//    unreachable without it.
//  * Input is validated and the hourly/daily spend guard is checked BEFORE asking for payment.
//  * No private keys: we only hold a receiving ADDRESS. CDP API keys live in env vars.

import { createBatch, refreshSearchRow } from './tgfinderBatch.js';
import { FINAL_SALE_NOTICE } from './config.js';

const QUERY_RE = /^[A-Za-z0-9@._:/\-?=%&+~#]{3,200}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,32}$/;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function safeUrl(v) {
  let w = String(v || '').trim();
  if (!w) return null;
  if (!/^https?:\/\//i.test(w)) w = 'https://' + w;
  try { const u = new URL(w); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
}

function tgUrl(v) {
  const raw = String(v || '').trim().replace(/^@/, '');
  if (/^[A-Za-z0-9_]{3,}$/.test(raw)) return `https://t.me/${raw}`;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    if (/^(www\.)?(t\.me|telegram\.me|telegram\.dog)$/i.test(u.hostname) && /^\/[A-Za-z0-9_+\-/]{3,}$/.test(u.pathname)) return 'https://t.me' + u.pathname;
  } catch { /* unusable */ }
  return null;
}

function xUrl(v) {
  let h = String(v || '').trim();
  const m = h.match(/(?:^|\/\/)(?:www\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i);
  h = m ? m[1] : h.replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(h) ? `https://x.com/${h}` : null;
}

// Stored summary → what an agent gets back: same data plus ready-to-open URLs.
function toAgentShape(company) {
  return {
    company_name: company.company_name || null,
    project_x_url: xUrl(company.project_x),
    website_url: safeUrl(company.website),
    telegram_channel_url: tgUrl(company.telegram_channel),
    team_members: (company.team_members || []).map(m => ({
      display_name: m.display_name || null,
      role: m.role || null,
      confidence: m.confidence || null,
      telegram_username: m.telegram_username || null,
      telegram_url: m.telegram_username ? tgUrl(m.telegram_username) : null,
      x_handle: m.x_handle || null,
      x_url: m.x_handle ? xUrl(m.x_handle) : null,
      website_url: safeUrl(m.website),
    })),
  };
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

export function mountX402Lookup(app, deps) {
  const { config, supabase, signJwt, verifyJwt, tgFinder, appUrl, alertAdmin = async () => {}, log = console } = deps;
  const cfg = config.x402;
  const net = cfg.network;
  const state = { mw: null, ready: false, error: null };

  const info = {
    endpoint: `${appUrl}/x402/tg-finder/lookup`,
    method: 'POST',
    body: { query: 'uniswap.org' },
    price_usd: cfg.priceUsd,
    asset: 'USDC',
    network: net.label,
    network_id: net.caip2,
    pay_to: cfg.payTo,
    policy: FINAL_SALE_NOTICE,
  };

  // ── Human + machine readable explainer (free) ──────────────────────────────
  app.get('/x402', (req, res) => res.type('html').send(renderInfoPage({ info, net, cfg, enabled: cfg.enabled, appUrl })));
  app.get('/x402/tg-finder/lookup', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'use_post', ...info }));

  if (!cfg.enabled || !supabase || !tgFinder.apiKey) {
    log.warn('[x402] disabled — needs CDP_API_KEY_ID, CDP_API_KEY_SECRET, X402_PAY_TO, Supabase and TG_FINDER_API_KEY');
    const off = (req, res) => res.status(503).json({ error: 'x402_unavailable', message: 'Agent lookups are not enabled on this server.' });
    app.post('/x402/tg-finder/lookup', off);
    app.get('/x402/tg-finder/result', off);
    return;
  }

  // ── Spend guard: every lookup costs real credits on the shared TG Finder account ──
  const startedAt = [];            // timestamps of lookups actually started (in-memory; resets on redeploy)
  const within = ms => startedAt.filter(t => Date.now() - t < ms).length;
  const atCapacity = () => within(3600_000) >= cfg.maxPerHour || within(86_400_000) >= cfg.maxPerDay;

  // Runs BEFORE the payment middleware so bad input / no capacity never triggers a payment request.
  function preflight(req, res, next) {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!QUERY_RE.test(query)) {
      return res.status(400).json({ error: 'invalid_query', message: 'Send JSON {"query": "<company domain or X profile>"} — e.g. {"query":"uniswap.org"}. One lookup per request.' });
    }
    if (atCapacity()) {
      return res.status(429).set('Retry-After', '600').json({ error: 'at_capacity', message: 'Lookup capacity is full right now — try again in a few minutes. You have not been charged.' });
    }
    req.x402Query = query;
    next();
  }

  // Fail closed: if the x402 middleware isn't up, nothing reaches the paid handler.
  function gate(req, res, next) {
    if (!state.mw) {
      return res.status(503).set('Retry-After', '15').json({ error: 'x402_starting', message: state.error ? 'Payment service unavailable.' : 'Payment service is starting — retry in a few seconds.' });
    }
    return state.mw(req, res, next);
  }

  // ── Paid: starts the TG Finder search. Any status >= 400 here means the buyer is NOT charged. ──
  async function paidHandler(req, res) {
    const query = req.x402Query;
    const { data: row, error: insertErr } = await supabase.from('tg_finder_searches').insert({
      user_id: null, mode: 'real', status: 'queued', domains: [query], domains_count: 1, paid_search: true,
    }).select('id').single();
    if (insertErr) {
      log.error('[x402] insert failed:', insertErr.message);
      return res.status(500).json({ error: 'storage_error', message: 'Could not start the lookup. You have not been charged.' });
    }

    try {
      const r = await createBatch([query], tgFinder);
      if (!r.ok) {
        await supabase.from('tg_finder_searches').update({ status: 'failed', error: r.body?.error?.message || r.body?.error || 'TG Finder request failed' }).eq('id', row.id);
        if (r.status === 402) {
          alertAdmin('⚠️ Shared TG Finder account is out of credits — agent (x402) lookups are failing. Top up now.').catch(() => {});
        }
        return res.status(503).json({ error: 'lookup_unavailable', message: 'TG Finder is temporarily unavailable. You have not been charged.' });
      }

      await supabase.from('tg_finder_searches').update({ tgfinder_batch_id: r.body.id, status: r.body.status || 'queued' }).eq('id', row.id);
      startedAt.push(Date.now());

      const token = await signJwt({ purpose: 'x402_poll', searchId: row.id });
      return res.status(200).json({
        ok: true,
        search_id: row.id,
        status: r.body.status || 'queued',
        poll_url: `${appUrl}/x402/tg-finder/result?token=${token}`,
        message: 'Lookup started. Poll poll_url (free) every ~3 seconds until status is "completed". Typical time: under a minute.',
        policy: FINAL_SALE_NOTICE,
      });
    } catch (err) {
      await supabase.from('tg_finder_searches').update({ status: 'failed', error: err.message }).eq('id', row.id);
      log.error('[x402] lookup start failed:', err.message);
      return res.status(503).json({ error: 'lookup_unavailable', message: 'TG Finder is temporarily unavailable. You have not been charged.' });
    }
  }

  app.post('/x402/tg-finder/lookup', preflight, gate, paidHandler);

  // ── Free, token-gated result polling ───────────────────────────────────────
  app.get('/x402/tg-finder/result', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let payload;
    try { payload = await verifyJwt(String(req.query.token || ''), 'x402_poll'); }
    catch { return res.status(401).json({ error: 'invalid_token', message: 'Use the poll_url returned by the lookup call.' }); }

    const { data: row } = await supabase.from('tg_finder_searches').select('*').eq('id', payload.searchId).maybeSingle();
    // Agent lookups only: a row owned by a TGcrm user can never be read through this route.
    if (!row || row.user_id !== null || row.paid_search !== true) return res.status(404).json({ error: 'not_found' });

    let { status, result_summary: result, error } = row;
    let progress = null;
    if (!['completed', 'failed'].includes(row.status) && row.tgfinder_batch_id) {
      try {
        const r = await refreshSearchRow(supabase, row, tgFinder);
        status = r.status; result = r.result; error = r.error; progress = r.progress;
      } catch { /* transient — the agent just polls again */ }
    }

    return res.json({
      ok: true,
      status,
      progress,
      results: status === 'completed' && Array.isArray(result) ? result.map(toAgentShape) : null,
      error: status === 'failed' ? (error || 'Lookup failed') : null,
    });
  });

  // ── Boot the CDP facilitator connection in the background (~6s import + facilitator sync) ──
  (async () => {
    try {
      const [{ createX402Server }, { paymentMiddlewareFromHTTPServer }] = await Promise.all([
        import('@coinbase/cdp-sdk/x402'),
        import('@x402/express'),
      ]);
      const server = await withTimeout(createX402Server({
        environment: cfg.environment,
        payToConfig: { type: 'address', evm: cfg.payTo },
        routes: {
          'POST /x402/tg-finder/lookup': {
            price: `$${cfg.priceUsd}`,
            networks: [net.caip2],
            description: 'TG Finder: find the Telegram handles (plus X profiles and websites) of the people behind a company. One lookup per request.',
          },
        },
      }), 30_000, 'createX402Server');

      // One row per settled payment → proof of onchain activity (transaction hash, payer, network).
      server.resourceServer.onAfterSettle(async ctx => {
        const r = ctx.result || {};
        log.log(`[x402] settled ${r.amount} on ${r.network} tx=${r.transaction} payer=${r.payer}`);
        supabase.from('events').insert({
          user_id: null, event_type: 'x402_payment_settled',
          metadata: { transaction: r.transaction, payer: r.payer, network: r.network, amount: r.amount },
        }).then(() => {}).catch(() => {});
      });

      state.mw = paymentMiddlewareFromHTTPServer(server);
      state.ready = true;
      log.log(`[x402] ready — ${info.endpoint} costs $${cfg.priceUsd} USDC on ${net.label}, paid to ${cfg.payTo}`);
    } catch (err) {
      state.error = err;
      log.error('[x402] failed to start (agent lookups stay off, rest of the app is unaffected):', err.message);
    }
  })();
}

function renderInfoPage({ info, net, cfg, enabled, appUrl }) {
  const code = `import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment } from "@x402/fetch";

// Your agent's own wallet. Needs USDC on ${net.label}.
const client = new CdpX402Client({ environment: "${cfg.environment}" });
const pay = wrapFetchWithPayment(fetch, client);

const start = await pay("${info.endpoint}", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: "uniswap.org" }),
});
const { poll_url } = await start.json();        // paid $${cfg.priceUsd} USDC onchain
// …poll poll_url (free) until status === "completed"`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TG Finder for agents — pay per lookup in USDC on Base</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:#0d1117;color:#e8edf5;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 20px 64px}
h1{font-size:28px;margin:0 0 6px}p.sub{color:#8fa3bc;margin:0 0 28px}
.card{background:#131b27;border:1px solid #1e2d42;border-radius:14px;padding:20px;margin:0 0 18px}
.card h2{font-size:15px;margin:0 0 10px;color:#a78bfa;text-transform:uppercase;letter-spacing:.06em}
dl{display:grid;grid-template-columns:130px 1fr;gap:8px 14px;margin:0}dt{color:#8fa3bc}dd{margin:0;word-break:break-all}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
pre{background:#0c121c;border:1px solid #1e2d42;border-radius:10px;padding:14px;overflow-x:auto;margin:0}
a{color:#a78bfa}.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:700;background:${enabled ? 'rgba(34,197,94,.15);color:#4ade80' : 'rgba(239,68,68,.15);color:#f87171'}}
.fine{color:#8fa3bc;font-size:13px}
</style></head><body><main>
<h1>🔍 TG Finder for agents</h1>
<p class="sub">Give your AI agent a company domain or X profile — it pays <b>$${esc(cfg.priceUsd)} USDC on Base</b> and gets back the Telegram handles, X profiles and websites of the people behind it. No signup. No API key. <span class="pill">${enabled ? 'live' : 'not enabled'}</span></p>
<div class="card"><h2>Endpoint</h2><dl>
<dt>Request</dt><dd><code>POST ${esc(info.endpoint)}</code></dd>
<dt>Body</dt><dd><code>{"query": "uniswap.org"}</code> — a company website or X profile, one per request</dd>
<dt>Price</dt><dd>$${esc(cfg.priceUsd)} USDC per lookup, charged only if the lookup starts</dd>
<dt>Network</dt><dd>${esc(net.label)} · <code>${esc(net.caip2)}</code></dd>
<dt>Paid to</dt><dd><a href="${esc(net.explorer)}/address/${esc(cfg.payTo)}" target="_blank" rel="noopener"><code>${esc(cfg.payTo)}</code></a></dd>
<dt>Then</dt><dd>Poll the returned <code>poll_url</code> (free) until <code>status</code> is <code>completed</code></dd>
</dl></div>
<div class="card"><h2>How an agent pays (x402)</h2><pre>${esc(code)}</pre></div>
<div class="card"><h2>See the payment request</h2><pre>curl -i -X POST ${esc(info.endpoint)} \\
  -H 'content-type: application/json' -d '{"query":"uniswap.org"}'
# → HTTP 402 with the price, asset and payTo address in the PAYMENT-REQUIRED header</pre></div>
<p class="fine">${esc(FINAL_SALE_NOTICE)} A lookup that can't start is never charged. Payments settle onchain via Coinbase's x402 facilitator. Part of <a href="${esc(appUrl)}">TGcrm</a> — the Telegram-native CRM.</p>
</main></body></html>`;
}
