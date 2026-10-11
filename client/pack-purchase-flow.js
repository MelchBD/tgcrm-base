// Browser side of the Pro lookup-pack purchase (Base Pay).
//
// EXCERPT from TGcrm's single-file frontend (index.html, which is part of the private product).
// It is included so the full flow can be reviewed: order -> Base Pay wallet popup -> server verification -> credits.
// It relies on a few host helpers defined elsewhere in that file: _esc (HTML-escape), showToast,
// openTgFinderModal, showUpgradeModal, _startCheckout, and the shared _tgfStatus object.
// The server half is src/usdcPacks.js.
//
// Key points:
//  * The wallet popup only moves money; credits are granted by the SERVER after it verifies the payment onchain.
//  * 'All purchases are final - no refunds' must be ticked before an order is created.
//  * If the tab closes between paying and crediting, the pending claim is stored and finished on next open.
//  * Each panel is a fresh attempt, so a wallet window that was closed can never leave the Pay button dead.

// ─── TG Finder lookup packs — Pro pays in USDC on Base (Base Pay) ─────────────
// Flow: reserve an order on the server (it returns the EXACT amount to pay, incl. a
// tiny order code) → Base Pay wallet popup → server verifies the payment onchain and
// grants the credits. The browser's "payment succeeded" is never what grants credits.
// If the tab closes between paying and crediting, the pending claim is stored and
// finished automatically next time TG Finder opens.
let _tgfPackBusy = false;
let _tgfPackAttempt = 0;   // bumped on every new panel / purchase so an abandoned attempt can never block or overwrite a newer one
let _basePayPromise = null;
const _TGF_PENDING_KEY = 'tgf_pending_claim';

// Served from our own server (pinned npm package) rather than a third-party CDN.
function _loadBasePay() {
  if (window.base?.pay) return Promise.resolve(window.base);
  if (!_basePayPromise) {
    _basePayPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/base-account.min.js';
      s.onload = () => window.base?.pay ? resolve(window.base) : reject(new Error('Wallet payments failed to load'));
      s.onerror = () => reject(new Error('Wallet payments failed to load'));
      document.head.appendChild(s);
    }).catch(e => { _basePayPromise = null; throw e; });
  }
  return _basePayPromise;
}

function _tgfSavePendingClaim(c) { try { localStorage.setItem(_TGF_PENDING_KEY, JSON.stringify(c)); } catch {} }
function _tgfClearPendingClaim() { try { localStorage.removeItem(_TGF_PENDING_KEY); } catch {} }
function _tgfLoadPendingClaim() { try { return JSON.parse(localStorage.getItem(_TGF_PENDING_KEY) || 'null'); } catch { return null; } }

// Polls the server until the payment is verified onchain and credited.
// Throws on a definitive failure; keeps the stored claim when it's safe to retry later.
async function _tgfClaim(orderId, paymentId, say) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch('/api/usdc/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId, payment_id: paymentId }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) {
      _tgfClearPendingClaim();
      _tgfStatus.credits = d.credits;
      return d;
    }
    if (r.status === 202) { say?.('Confirming on Base… (usually a few seconds)'); await new Promise(res => setTimeout(res, 2500)); continue; }
    if (r.status === 500) throw new Error(d.message || 'Your payment was received but crediting hit a snag — reopen this window in a minute and it will finish automatically.');
    _tgfClearPendingClaim();   // 4xx: mismatch / already used / expired — retrying can't help
    throw new Error(d.message || d.error || 'This payment could not be matched to your order.');
  }
  throw new Error('Still confirming — your payment is safe. Reopen this window in a minute and it will finish automatically.');
}

let _tgfResuming = false;
async function _tgfResumeClaim() {
  const c = _tgfLoadPendingClaim();
  if (_tgfResuming || _tgfPackBusy || !c?.order_id || !c?.payment_id) return;   // one recovery at a time; never race a live purchase
  _tgfResuming = true;
  try {
    const d = await _tgfClaim(c.order_id, c.payment_id);
    showToast(`✅ TG Finder lookups added — balance ${d.credits}`, 'success');
  } catch { /* stays stored if retryable; cleared by _tgfClaim otherwise */ }
  finally { _tgfResuming = false; }
}

async function _tgfShowPacks(opts = {}) {
  // A fresh panel is a fresh attempt. If an earlier wallet window was closed without answering, that attempt may
  // still be 'waiting' — it must never leave this panel's Pay button disabled.
  _tgfPackAttempt++; _tgfPackBusy = false;
  _tgfResumeClaim();
  _loadBasePay().catch(() => {});   // preload so the wallet popup opens inside the click's user-gesture window
  document.getElementById('tgf-packs-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'tgf-packs-overlay';
  overlay.className = 'upgrade-ai-overlay';
  overlay.innerHTML = `<div class="upgrade-ai-modal tgf-packs-modal"><div class="upgrade-ai-title">🔍 Buy TG Finder lookups</div><div id="tgf-packs-body" style="display:flex;flex-direction:column;gap:14px"><div class="upgrade-ai-sub">Loading…</div></div></div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay && !_tgfPackBusy) overlay.remove(); });
  document.body.appendChild(overlay);
  const body = document.getElementById('tgf-packs-body');
  const close = `document.getElementById('tgf-packs-overlay').remove()`;

  let info;
  try { info = await (await fetch('/api/usdc/packs')).json(); } catch { info = null; }
  if (!info || !info.enabled) {
    body.innerHTML = `<div class="upgrade-ai-sub">USDC purchases aren't available right now. You can also go unlimited with BD Brain.</div>
      <button class="tgf-primary-btn" onclick="${close};showUpgradeModal(true)">See BD Brain — $75/mo</button>
      <button class="upgrade-ai-dismiss" onclick="${close}">Close</button>`;
    return;
  }
  _tgfStatus.credits = info.credits;
  if (!info.can_buy) {
    body.innerHTML = info.reason === 'bd_brain_unlimited'
      ? `<div class="upgrade-ai-sub">BD Brain already includes unlimited TG Finder lookups.</div><button class="upgrade-ai-dismiss" onclick="${close}">Close</button>`
      : `<div class="upgrade-ai-sub">Lookup packs are available on the Pro plan.</div>
         <button class="tgf-primary-btn" onclick="${close};_startCheckout('pro')">Upgrade to Pro — $20/mo</button>
         <button class="upgrade-ai-dismiss" onclick="${close}">Not now</button>`;
    return;
  }

  const pack = info.packs[0];
  const each = (parseFloat(pack.price_usdc) / pack.lookups).toFixed(2);
  body.innerHTML = `
    <div class="upgrade-ai-sub">${_esc(opts.message || 'Each lookup finds the Telegram handles, X profiles and websites of the people behind one company.')}</div>
    ${info.testnet ? `<div class="tgf-pack-test">TEST MODE — ${_esc(info.network)}. Test USDC only, no real money moves.</div>` : ''}
    <div class="tgf-pack-balance">Your balance: <b>${info.credits} lookup${info.credits === 1 ? '' : 's'}</b>${info.free_available ? ' <span style="color:#4ade80">+ 1 free lookup (used first)</span>' : ''}</div>
    <div class="tgf-pack-card"><div><b>${pack.lookups} lookups</b><br><span>$${_esc(pack.price_usdc)} USDC · $${each} each</span></div></div>
    <label class="tgf-pack-terms"><input type="checkbox" id="tgf-pack-terms" onchange="_tgfPackTermsChanged(this)"> <span><b>${_esc(info.notice)}</b> I understand and agree.</span></label>
    <button class="tgf-primary-btn" id="tgf-pack-pay" disabled onclick="_tgfBuyPack('${_esc(pack.id)}')">Pay $${_esc(pack.price_usdc)} with USDC on Base</button>
    <div class="upgrade-ai-sub" id="tgf-pack-status" style="min-height:18px"></div>
    <div class="tgf-pack-fine">Pay from a Base Account or Coinbase wallet holding USDC on Base. Your total includes a tiny order code (under 1¢) so we can match your payment automatically. Payments settle onchain — you can verify yours on <a href="${_esc(info.explorer)}/address/${_esc(info.to)}" target="_blank" rel="noopener" style="color:#a78bfa">Basescan</a>.</div>
    <button class="upgrade-ai-dismiss" onclick="${close}">Not now</button>
    <div class="tgf-pack-fine" style="text-align:center">Want unlimited lookups? <a onclick="${close};showUpgradeModal(true)" style="color:#a78bfa;cursor:pointer">BD Brain — $75/mo</a></div>`;
}

function _tgfPackTermsChanged(cb) {
  const pay = document.getElementById('tgf-pack-pay');
  if (pay) pay.disabled = !cb.checked;
}

async function _tgfBuyPack(packId) {
  if (_tgfPackBusy) return;
  const me = ++_tgfPackAttempt;
  const isCurrent = () => _tgfPackAttempt === me;
  const statusEl = document.getElementById('tgf-pack-status');
  const btn = document.getElementById('tgf-pack-pay');
  const say = (html, isErr) => { if (isCurrent() && statusEl) { statusEl.innerHTML = html; statusEl.style.color = isErr ? '#f87171' : ''; } };
  if (!document.getElementById('tgf-pack-terms')?.checked) { say('Please confirm that all purchases are final.', true); return; }
  _tgfPackBusy = true;
  if (btn) btn.disabled = true;
  let hintTimer = null;
  try {
    say('Creating your order…');
    const or = await fetch('/api/usdc/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pack: packId, accepted_final_sale: true }),
    });
    const order = await or.json().catch(() => ({}));
    if (!or.ok) throw new Error(order.message || order.error || 'Could not create the order');

    say(`Confirm <b>${_esc(order.amount)} USDC</b> in the wallet window…`);
    // If the wallet window gets closed the SDK may never answer — offer a way out instead of a dead button.
    hintTimer = setTimeout(() => say(`Waiting for the wallet window… <a onclick="_tgfShowPacks()" style="color:#a78bfa;cursor:pointer;text-decoration:underline">Closed it? Start over</a>`), 20000);
    const base = await _loadBasePay();
    let payment;
    try {
      payment = await base.pay({ amount: order.amount, to: order.to, testnet: order.testnet });
    } catch (e) {
      const m = String(e?.message || '');
      throw new Error(/reject|denied|cancel|closed|dismiss/i.test(m)
        ? 'Payment cancelled — you have not been charged.'
        : /popup|blocked/i.test(m) ? 'Your browser blocked the wallet window — allow popups for this site and try again.' : (m || 'Payment failed'));
    } finally { clearTimeout(hintTimer); }
    if (!payment?.id) throw new Error('The wallet did not return a payment id — you have not been charged.');

    _tgfSavePendingClaim({ order_id: order.order_id, payment_id: payment.id });
    say('Payment sent — confirming on Base…');
    const done = await _tgfClaim(order.order_id, payment.id, say);

    if (!isCurrent()) { showToast(`✅ +${done.added} TG Finder lookups added — balance ${done.credits}`, 'success'); return; }   // user moved on; still credited
    document.getElementById('tgf-packs-body').innerHTML = `
      <div class="upgrade-ai-sub" style="color:#4ade80;font-weight:700;font-size:15px">✅ +${done.added} lookups added</div>
      <div class="upgrade-ai-sub">Your balance is now <b style="color:#e8edf5">${done.credits}</b> lookups. A receipt is on its way to your TGcrm bot chat.</div>
      <div class="tgf-pack-fine">${_esc(order.notice)}</div>
      <button class="tgf-primary-btn" onclick="document.getElementById('tgf-packs-overlay').remove();openTgFinderModal()">Start a search →</button>
      <button class="upgrade-ai-dismiss" onclick="document.getElementById('tgf-packs-overlay').remove()">Close</button>`;
  } catch (e) {
    say(_esc(e.message || 'Something went wrong'), true);
    if (isCurrent() && btn) btn.disabled = !document.getElementById('tgf-pack-terms')?.checked;
  } finally {
    clearTimeout(hintTimer);
    if (isCurrent()) _tgfPackBusy = false;
  }
}
