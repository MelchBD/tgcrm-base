// Backend tests for the Base payment features: an in-memory Supabase fake + a fake Base Pay verifier.
// Run: npm test
// Integration tests for lib/base/* using an in-memory Supabase fake and a fake Base Pay verifier.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { getBaseConfig, toMicro, fromMicro } from '../src/config.js';
import { mountUsdcPacks } from '../src/usdcPacks.js';
import { mountX402Lookup } from '../src/x402Lookup.js';
import { summarizeBatch } from '../src/tgfinderBatch.js';

// ── tiny chainable in-memory supabase ─────────────────────────────────────────
function makeDb(seed) {
  const tables = structuredClone(seed);
  let ids = { usdc_orders: 100, events: 1 };
  const uniques = { usdc_orders: ['tx_hash'] };
  function from(name) {
    const q = { filters: [], op: 'select', payload: null, count: false, head: false, cols: '*' };
    const rows = () => (tables[name] ||= []);
    const match = r => q.filters.every(f => f(r));
    const api = {
      select(cols, opts) { if (q.op === 'select') { q.cols = cols; } q.returning = true; if (opts?.count) { q.count = true; q.head = !!opts.head; } return api; },
      insert(p) { q.op = 'insert'; q.payload = p; return api; },
      update(p) { q.op = 'update'; q.payload = p; return api; },
      eq(c, v) { q.filters.push(r => String(r[c]) === String(v)); return api; },
      is(c, v) { q.filters.push(r => (r[c] ?? null) === v); return api; },
      in(c, arr) { q.filters.push(r => arr.includes(r[c])); return api; },
      lt(c, v) { q.filters.push(r => r[c] < v); return api; },
      gte(c, v) { q.filters.push(r => r[c] >= v); return api; },
      then(res, rej) { return run().then(res, rej); },
      async maybeSingle() { const r = await run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      async single() { const r = await run(); return { data: r.data?.[0] ?? null, error: r.error }; },
    };
    async function run() {
      if (q.op === 'insert') {
        const row = { id: ids[name]++, created_at: new Date().toISOString(), ...q.payload };
        for (const u of uniques[name] || []) if (row[u] != null && rows().some(x => x[u] === row[u])) return { data: null, error: { code: '23505', message: 'duplicate' } };
        rows().push(row); return { data: [row], error: null };
      }
      if (q.op === 'update') {
        const hit = rows().filter(match);
        for (const u of uniques[name] || []) if (q.payload[u] != null && hit.length && rows().some(x => x[u] === q.payload[u] && !hit.includes(x))) return { data: null, error: { code: '23505', message: 'duplicate' } };
        hit.forEach(r => Object.assign(r, q.payload));
        return { data: q.returning ? hit.map(r => ({ ...r })) : null, error: null };
      }
      const hit = rows().filter(match);
      if (q.count) return { count: hit.length, data: q.head ? null : hit, error: null };
      return { data: hit.map(r => ({ ...r })), error: null };
    }
    return api;
  }
  return { from, tables };
}

const PAY_TO = '0xed37a3659c9c6b28b5d86dac12dd78ab54e355e8';
const ID1 = '0x' + 'a'.repeat(64), ID2 = '0x' + 'b'.repeat(64);

const t = (name, fn) => test(name, fn);

// ── harness: express app with fake auth (Authorization: Bearer <telegramId>) ──
async function boot({ users, verifier, env }) {
  const db = makeDb({ users, usdc_orders: [], events: [] });
  const app = express(); app.use(express.json());
  const requireAuthJwtOnly = (req, res, next) => { req.telegramId = (req.headers.authorization || '').replace('Bearer ', ''); next(); };
  const sent = [], events = [], alerts = [];
  mountUsdcPacks(app, {
    config: getBaseConfig({ USDC_PAY_TO: PAY_TO, USDC_NETWORK: 'base-sepolia', ...env }),
    supabase: db, requireAuthJwtOnly,
    sendBotMsg: async (chat, text) => sent.push({ chat, text }), openAppButton: l => ({ l }),
    logEvent: (tid, type, meta) => events.push({ tid, type, meta }), alertAdmin: async m => alerts.push(m),
    getPaymentStatus: verifier, log: { warn() {}, error() {}, log() {} },
  });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, who, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${who}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { db, call, sent, events, alerts, base, close: () => srv.close() };
}

await t('micro math is exact', () => { assert.equal(toMicro('10.00'), 10_000_000n); assert.equal(fromMicro(10_003_417n), '10.003417'); assert.equal(fromMicro(toMicro('1')), '1.000000'); });
await t('defaults are TESTNET, features off without keys', () => {
  const c = getBaseConfig({});
  assert.equal(c.x402.environment, 'development'); assert.equal(c.x402.networkKey, 'base-sepolia');
  assert.equal(c.x402.enabled, false); assert.equal(c.packs.enabled, false); assert.equal(c.packs.networkKey, 'base-sepolia');
});
await t('production only when explicitly set', () => {
  const c = getBaseConfig({ X402_ENV: 'production', X402_PAY_TO: PAY_TO, CDP_API_KEY_ID: 'a', CDP_API_KEY_SECRET: 'b', USDC_NETWORK: 'base' });
  assert.equal(c.x402.networkKey, 'base'); assert.equal(c.x402.enabled, true); assert.equal(c.packs.networkKey, 'base');
  assert.equal(c.x402.network.caip2, 'eip155:8453');
});
await t('bad pay-to address disables the feature', () => assert.equal(getBaseConfig({ X402_PAY_TO: '0x123', CDP_API_KEY_ID: 'a', CDP_API_KEY_SECRET: 'b' }).x402.enabled, false));

let verdictFor = () => ({ status: 'completed', sender: '0xPAYER', amount: '10.000000', recipient: PAY_TO });
const users = [
  { telegram_id: 1, subscription_tier: 'pro', tg_finder_credits: 0, bot_chat_id: 555 },
  { telegram_id: 2, subscription_tier: 'pro', tg_finder_credits: 3, bot_chat_id: null },
  { telegram_id: 3, subscription_tier: 'bd_brain', tg_finder_credits: 0 },
  { telegram_id: 4, subscription_tier: 'free', tg_finder_credits: 0 },
  { telegram_id: 6, subscription_tier: 'pro', tg_finder_credits: 0 },
];
const A = await boot({ users, verifier: async o => verdictFor(o) });

await t('packs: Pro can buy, shows price/notice/balance', async () => {
  const r = await A.call('GET', '/api/usdc/packs', 2);
  assert.equal(r.status, 200); assert.equal(r.body.can_buy, true); assert.equal(r.body.credits, 3);
  assert.deepEqual(r.body.packs, [{ id: 'tgf_pack', lookups: 10, price_usdc: '10.00' }]);
  assert.match(r.body.notice, /final — no refunds/); assert.equal(r.body.to, PAY_TO); assert.equal(r.body.testnet, true);
});
await t('Base Pay SDK is served from our own server (no third-party CDN)', async () => {
  const r = await fetch(A.base + '/vendor/base-account.min.js');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
  const js = await r.text(); assert.ok(js.length > 500_000 && js.includes('window.base'), `len ${js.length}`);
});
await t('packs: BD Brain / Free cannot buy', async () => {
  assert.equal((await A.call('GET', '/api/usdc/packs', 3)).body.reason, 'bd_brain_unlimited');
  assert.equal((await A.call('GET', '/api/usdc/packs', 4)).body.reason, 'pro_required');
  assert.equal((await A.call('POST', '/api/usdc/order', 3, { pack: 'tgf_pack', accepted_final_sale: true })).status, 400);
  assert.equal((await A.call('POST', '/api/usdc/order', 4, { pack: 'tgf_pack', accepted_final_sale: true })).status, 403);
});
await t('order: refuses without accepting "all sales final"', async () => {
  const r = await A.call('POST', '/api/usdc/order', 1, { pack: 'tgf_pack' });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'terms_required');
  assert.equal((await A.call('POST', '/api/usdc/order', 1, { pack: 'tgf_pack', accepted_final_sale: 'yes' })).status, 400);
});
await t('order: unknown pack rejected', async () => assert.equal((await A.call('POST', '/api/usdc/order', 1, { pack: 'free_money', accepted_final_sale: true })).status, 400));
let o1, o2;
await t('order: amount = price + order code (<1¢), 6 decimals, final-sale notice, logged', async () => {
  o1 = (await A.call('POST', '/api/usdc/order', 1, { pack: 'tgf_pack', accepted_final_sale: true })).body;
  const micro = toMicro(o1.amount);
  assert.ok(micro > 10_000_000n && micro < 10_010_000n, o1.amount);
  assert.equal(o1.to, PAY_TO); assert.equal(o1.testnet, true); assert.match(o1.notice, /no refunds/);
  assert.ok(A.events.some(e => e.type === 'usdc_order_created' && e.meta.accepted_final_sale === true));
});
await t('order: two users never get the same amount', async () => {
  o2 = (await A.call('POST', '/api/usdc/order', 2, { pack: 'tgf_pack', accepted_final_sale: true })).body;
  assert.notEqual(o1.amount, o2.amount);
  const amounts = new Set([o1.amount, o2.amount]);
  for (let i = 0; i < 40; i++) { const r = await A.call('POST', '/api/usdc/order', 4 + 10 + i, { pack: 'tgf_pack', accepted_final_sale: true }); if (r.status === 403) continue; }
  assert.equal(amounts.size, 2);
});
await t('RETRY: a new order replaces the old unpaid one - closing the wallet never locks anyone out', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await A.call('POST', '/api/usdc/order', 1, { pack: 'tgf_pack', accepted_final_sale: true })).status, 200);
  const mine = A.db.tables.usdc_orders.filter(x => x.telegram_id === 1);
  assert.equal(mine.filter(x => x.status === 'pending').length, 1, 'exactly one live order');
  assert.ok(mine.filter(x => x.status === 'superseded').length >= 4, 'older ones superseded');
  assert.equal(new Set(mine.map(x => x.amount_usdc)).size, mine.length, 'amounts are never reused');
});
await t('spam guard: 11th order within an hour is refused', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await A.call('POST', '/api/usdc/order', 6, { pack: 'tgf_pack', accepted_final_sale: true });
  assert.equal(last.status, 429); assert.equal(last.body.error, 'too_many_orders');
});

await t('claim: validates input', async () => {
  assert.equal((await A.call('POST', '/api/usdc/claim', 1, { order_id: o1.order_id, payment_id: 'nope' })).status, 400);
  assert.equal((await A.call('POST', '/api/usdc/claim', 1, { payment_id: ID1 })).status, 400);
});
await t("claim: cannot claim someone else's order", async () => assert.equal((await A.call('POST', '/api/usdc/claim', 2, { order_id: o1.order_id, payment_id: ID1 })).status, 404));
await t('claim: verifier receives the EXACT amount + our address + testnet flag', async () => {
  let seen; verdictFor = o => { seen = o; return { status: 'completed', sender: '0xPAYER' }; };
  const r = await A.call('POST', '/api/usdc/claim', 1, { order_id: o1.order_id, payment_id: ID1 });
  assert.equal(r.status, 200); assert.equal(seen.expectedPayment.amount, o1.amount); assert.equal(seen.expectedPayment.recipient, PAY_TO);
  assert.equal(seen.testnet, true); assert.equal(seen.id, ID1);
});
await t('claim: credits granted once (+10), bot DM carries "no refunds"', async () => {
  const u = A.db.tables.users.find(x => x.telegram_id === 1);
  assert.equal(u.tg_finder_credits, 10);
  const o = A.db.tables.usdc_orders.find(x => x.id === o1.order_id);
  assert.equal(o.status, 'paid'); assert.equal(o.tx_hash, ID1.toLowerCase()); assert.equal(o.payer, '0xPAYER'); assert.ok(o.credits_granted_at);
  assert.ok(A.sent[0].text.includes('+10 TG Finder lookups') && /no refunds/.test(A.sent[0].text));
  assert.ok(A.events.some(e => e.type === 'usdc_pack_purchased'));
});
await t('claim: repeating the same claim is idempotent (no double credit)', async () => {
  const r = await A.call('POST', '/api/usdc/claim', 1, { order_id: o1.order_id, payment_id: ID1 });
  assert.equal(r.status, 200); assert.equal(r.body.already, true);
  assert.equal(A.db.tables.users.find(x => x.telegram_id === 1).tg_finder_credits, 10);
});
await t('claim: same order, different payment id → rejected', async () => assert.equal((await A.call('POST', '/api/usdc/claim', 1, { order_id: o1.order_id, payment_id: ID2 })).status, 409));
await t('REPLAY: one payment id cannot pay a second order', async () => {
  const r = await A.call('POST', '/api/usdc/claim', 2, { order_id: o2.order_id, payment_id: ID1 });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'payment_already_used');
  assert.equal(A.db.tables.users.find(x => x.telegram_id === 2).tg_finder_credits, 3);
  assert.equal(A.db.tables.usdc_orders.find(x => x.id === o2.order_id).status, 'pending');
});
await t('wrong amount / wrong recipient → rejected, no credits', async () => {
  verdictFor = () => { throw new Error('Unable to verify payment: USDC amount does not match the expected amount.'); };
  const r = await A.call('POST', '/api/usdc/claim', 2, { order_id: o2.order_id, payment_id: ID2 });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'payment_mismatch');
  assert.equal(A.db.tables.users.find(x => x.telegram_id === 2).tg_finder_credits, 3);
});
await t('payment still pending / bundler hiccup → 202 retry, nothing granted', async () => {
  verdictFor = () => ({ status: 'pending' });
  assert.equal((await A.call('POST', '/api/usdc/claim', 2, { order_id: o2.order_id, payment_id: ID2 })).status, 202);
  verdictFor = () => { throw new Error('RPC error: Network error'); };
  assert.equal((await A.call('POST', '/api/usdc/claim', 2, { order_id: o2.order_id, payment_id: ID2 })).status, 202);
  verdictFor = () => ({ status: 'failed', reason: 'Insufficient USDC balance' });
  const r = await A.call('POST', '/api/usdc/claim', 2, { order_id: o2.order_id, payment_id: ID2 });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'payment_failed');
  assert.equal(A.db.tables.users.find(x => x.telegram_id === 2).tg_finder_credits, 3);
});
await t('valid second purchase works (3 + 10 = 13)', async () => {
  verdictFor = () => ({ status: 'completed', sender: '0xOTHER' });
  const r = await A.call('POST', '/api/usdc/claim', 2, { order_id: o2.order_id, payment_id: ID2 });
  assert.equal(r.status, 200); assert.equal(r.body.credits, 13);
});
await t('concurrent claims of one order grant credits exactly once', async () => {
  const o = (await A.call('POST', '/api/usdc/order', 1, { pack: 'tgf_pack', accepted_final_sale: true })).body;
  const ID3 = '0x' + 'c'.repeat(64);
  verdictFor = () => ({ status: 'completed', sender: '0xP3' });
  const before = A.db.tables.users.find(x => x.telegram_id === 1).tg_finder_credits;
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => A.call('POST', '/api/usdc/claim', 1, { order_id: o.order_id, payment_id: ID3 })));
  assert.ok(rs.every(r => r.status === 200));
  assert.equal(A.db.tables.users.find(x => x.telegram_id === 1).tg_finder_credits, before + 10);
});
await t('LATE CLAIM: paid, closed the tab, order since replaced -> still credited once (within 24h)', async () => {
  const first = (await A.call('POST', '/api/usdc/order', 2, { pack: 'tgf_pack', accepted_final_sale: true })).body;
  const second = (await A.call('POST', '/api/usdc/order', 2, { pack: 'tgf_pack', accepted_final_sale: true })).body;   // user retried -> first is superseded
  assert.equal(A.db.tables.usdc_orders.find(x => x.id === first.order_id).status, 'superseded');
  const before = A.db.tables.users.find(x => x.telegram_id === 2).tg_finder_credits;
  verdictFor = () => ({ status: 'completed', sender: '0xLATE' });
  const r = await A.call('POST', '/api/usdc/claim', 2, { order_id: first.order_id, payment_id: '0x' + '1'.repeat(64) });
  assert.equal(r.status, 200);
  assert.equal(A.db.tables.users.find(x => x.telegram_id === 2).tg_finder_credits, before + 10);
  assert.notEqual(first.amount, second.amount);
});
await t('LATE CLAIM is still tied to the owner: another user cannot claim it', async () => {
  const o = (await A.call('POST', '/api/usdc/order', 2, { pack: 'tgf_pack', accepted_final_sale: true })).body;
  await A.call('POST', '/api/usdc/order', 2, { pack: 'tgf_pack', accepted_final_sale: true });
  verdictFor = () => ({ status: 'completed', sender: '0xTHIEF' });
  assert.equal((await A.call('POST', '/api/usdc/claim', 1, { order_id: o.order_id, payment_id: '0x' + '2'.repeat(64) })).status, 404);
});
await t('an order older than 24h cannot be claimed automatically; one just inside the window can', async () => {
  const old = (await A.call('POST', '/api/usdc/order', 2, { pack: 'tgf_pack', accepted_final_sale: true })).body;
  A.db.tables.usdc_orders.find(x => x.id === old.order_id).created_at = new Date(Date.now() - 25 * 3600e3).toISOString();
  verdictFor = () => ({ status: 'completed', sender: '0xOLD' });
  assert.equal((await A.call('POST', '/api/usdc/claim', 2, { order_id: old.order_id, payment_id: '0x' + '3'.repeat(64) })).status, 410);
  const fresh = (await A.call('POST', '/api/usdc/order', 2, { pack: 'tgf_pack', accepted_final_sale: true })).body;
  const row = A.db.tables.usdc_orders.find(x => x.id === fresh.order_id);
  row.status = 'expired'; row.created_at = new Date(Date.now() - 23 * 3600e3).toISOString();
  assert.equal((await A.call('POST', '/api/usdc/claim', 2, { order_id: fresh.order_id, payment_id: '0x' + '4'.repeat(64) })).status, 200);
});
await t('credit grant failure → lock released + admin alerted (retryable)', async () => {
  const B = await boot({ users: [{ telegram_id: 9, subscription_tier: 'pro', tg_finder_credits: 0 }], verifier: async () => ({ status: 'completed', sender: '0xZ' }) });
  const o = (await B.call('POST', '/api/usdc/order', 9, { pack: 'tgf_pack', accepted_final_sale: true })).body;
  B.db.tables.users.length = 0; // user vanishes → grant fails
  const r = await B.call('POST', '/api/usdc/claim', 9, { order_id: o.order_id, payment_id: '0x' + 'e'.repeat(64) });
  assert.equal(r.status, 500); assert.equal(r.body.error, 'grant_failed');
  assert.equal(B.db.tables.usdc_orders[0].credits_granted_at, null); assert.ok(B.alerts.some(a => a.includes('PAID but credits not granted')));
  B.close();
});
A.close();

{
  const app = express(); app.use(express.json());
  const logs = [];
  mountX402Lookup(app, {
    config: getBaseConfig({ X402_PAY_TO: PAY_TO, CDP_API_KEY_ID: 'fake', CDP_API_KEY_SECRET: 'fake', X402_MAX_PER_HOUR: '1' }),
    supabase: makeDb({ tg_finder_searches: [], events: [] }), signJwt: async p => 'tok', verifyJwt: async () => { throw new Error('bad'); },
    tgFinder: { apiKey: 'k', apiBase: 'http://127.0.0.1:1' }, appUrl: 'https://app.example', log: { warn: m => logs.push(m), error: m => logs.push(m), log: m => logs.push(m) },
  });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (body) => fetch(base + '/x402/tg-finder/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await t('invalid query → 400 BEFORE any payment request', async () => {
    for (const q of [undefined, '', 'a', 'x y', 'a'.repeat(300), '<script>', { evil: 1 }]) assert.equal((await post({ query: q })).status, 400, JSON.stringify(q));
  });
  await t('valid query but payment layer not ready → 503, never reaches the paid handler', async () => {
    const r = await post({ query: 'uniswap.org' });
    assert.equal(r.status, 503); assert.match((await r.json()).error, /x402/);
  });
  await t('GET /x402 info page renders (price, network, pay-to, no-refund policy)', async () => {
    const html = await (await fetch(base + '/x402')).text();
    assert.ok(html.includes('$1.00 USDC') && html.includes('Base Sepolia') && html.includes(PAY_TO) && html.includes('no refunds') && html.includes('app.example/x402/tg-finder/lookup'));
  });
  await t('GET on lookup → 405 with machine-readable info', async () => {
    const r = await fetch(base + '/x402/tg-finder/lookup'); const j = await r.json();
    assert.equal(r.status, 405); assert.equal(j.price_usd, '1.00'); assert.equal(j.network_id, 'eip155:84532'); assert.equal(j.pay_to, PAY_TO);
  });
  await t('result: bad token → 401', async () => assert.equal((await fetch(base + '/x402/tg-finder/result?token=zzz')).status, 401));
  srv.close();
}
{
  const app = express(); app.use(express.json());
  mountX402Lookup(app, { config: getBaseConfig({}), supabase: null, signJwt: async () => '', verifyJwt: async () => ({}), tgFinder: {}, appUrl: 'https://x', log: { warn() {}, error() {}, log() {} } });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  await t('without CDP keys: paid route 503, info page says not enabled', async () => {
    assert.equal((await fetch(base + '/x402/tg-finder/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"uniswap.org"}' })).status, 503);
    assert.ok((await (await fetch(base + '/x402')).text()).includes('not enabled'));
  });
  srv.close();
}

await t('maps company links + member links; CSV member without x_url drops x_handle; non-terminal → null', () => {
  const body = { status: 'completed', results: [{ domain: 'uniswap.org', result: {
    company_name: 'Uniswap Labs', project_x: { handle: 'Uniswap' }, social_links: { website: 'https://uniswap.org', telegram: 'https://t.me/uniswap', twitter: 'x.com/other' },
    telegram_channel: { username: 'uniswap_official' },
    team_members: [
      { display_name: 'Hayden', role: 'CEO', telegram_username: null, confidence: 'high', x_handle: 'haydenzadams', x_url: 'https://x.com/haydenzadams', website: 'hayden.xyz' },
      { display_name: 'CSV Guy', telegram_username: 'csvguy', confidence: 'high', x_handle: 'csvguy', x_url: '' },
    ] } }, { domain: 'bad.com', result: null }] };
  const { isTerminal, resultSummary } = summarizeBatch(body);
  assert.equal(isTerminal, true); assert.equal(resultSummary.length, 1);
  assert.equal(resultSummary[0].project_x, 'Uniswap'); assert.equal(resultSummary[0].telegram_channel, 'uniswap_official');
  assert.equal(resultSummary[0].team_members[0].x_handle, 'haydenzadams'); assert.equal(resultSummary[0].team_members[1].x_handle, null);
  assert.equal(summarizeBatch({ status: 'running' }).resultSummary, null);
});


// The x402 boot attempts a real (fake-credential) call to Coinbase and leaves a 30s timeout pending; don't wait for it.
after(() => setTimeout(() => process.exit(process.exitCode || 0), 250));
