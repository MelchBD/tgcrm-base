#!/usr/bin/env node
// A tiny "AI agent" that buys a TG Finder lookup with USDC on Base — x402, no signup, no API key.
//
//   node scripts/x402-agent-demo.mjs uniswap.org                 # testnet (Base Sepolia, fake USDC)
//   node scripts/x402-agent-demo.mjs uniswap.org --mainnet       # real USDC on Base mainnet
//   node scripts/x402-agent-demo.mjs --faucet                    # testnet only: fund the agent wallet with test USDC
//   node scripts/x402-agent-demo.mjs --address                   # just print the agent wallet address
//
// Needs (your machine only — NOT Railway):
//   CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET   from portal.cdp.coinbase.com
// Optional:
//   TGCRM_URL   server to call (default https://app.tgcrm.xyz)
//
// The agent's wallet is a Coinbase-managed (CDP) wallet, so there is no private key to leak. It also has
// hard spend limits: nothing above $1.50 per payment, nothing above $5 in 24h, only on the chosen network.

import { CdpX402Client } from '@coinbase/cdp-sdk/x402';
import { wrapFetchWithPayment, decodePaymentResponseHeader } from '@x402/fetch';

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const query = args.find(a => !a.startsWith('--')) || 'uniswap.org';
const mainnet = flag('--mainnet');
const BASE_URL = (process.env.TGCRM_URL || 'https://app.tgcrm.xyz').replace(/\/$/, '');

const NET = mainnet
  ? { env: 'production',  caip2: 'eip155:8453',  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', scan: 'https://basescan.org',         faucet: null }
  : { env: 'development', caip2: 'eip155:84532', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', scan: 'https://sepolia.basescan.org', faucet: 'base-sepolia' };

for (const k of ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET']) {
  if (!process.env[k]) { console.error(`Missing ${k}. Create CDP keys at https://portal.cdp.coinbase.com and export them in this shell.`); process.exit(1); }
}

const client = new CdpX402Client({
  environment: NET.env,
  spendControls: {
    maxAmountPerPayment: { atomic: 1_500_000n, asset: NET.usdc },   // $1.50
    maxCumulativeSpend:  { atomic: 5_000_000n, asset: NET.usdc },   // $5.00
    maxCumulativeSpendWindow: '24h',
    allowedNetworks: [NET.caip2],
  },
});
const { evmAddress } = await client.getAddresses();
console.log(`\n🤖 Agent wallet: ${evmAddress}   (${mainnet ? 'Base mainnet — REAL USDC' : 'Base Sepolia — test USDC'})`);

if (flag('--address')) process.exit(0);

if (flag('--faucet')) {
  if (!NET.faucet) { console.error('The faucet only exists on testnet.'); process.exit(1); }
  const { CdpClient } = await import('@coinbase/cdp-sdk');
  const cdp = new CdpClient();
  const r = await cdp.evm.requestFaucet({ address: evmAddress, network: NET.faucet, token: 'usdc' });
  console.log(`✅ Requested test USDC: ${NET.scan}/tx/${r.transactionHash}\n   Wait ~10s for it to confirm, then run the demo again.`);
  process.exit(0);
}

const pay = wrapFetchWithPayment(globalThis.fetch, client);

console.log(`\n🔍 Looking up "${query}" via ${BASE_URL}/x402/tg-finder/lookup`);
const t0 = Date.now();
const res = await pay(`${BASE_URL}/x402/tg-finder/lookup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query }),
});
const started = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`❌ HTTP ${res.status}:`, started.message || started.error || started);
  if (res.status === 402) console.error(`   Is the agent wallet funded? Fund ${evmAddress} with USDC on ${mainnet ? 'Base' : 'Base Sepolia (run with --faucet)'}.`);
  process.exit(1);
}

const receipt = res.headers.get('PAYMENT-RESPONSE') || res.headers.get('X-PAYMENT-RESPONSE');
if (receipt) {
  try {
    const p = decodePaymentResponseHeader(receipt);
    console.log(`💸 Paid onchain: ${NET.scan}/tx/${p.transaction}\n   payer ${p.payer}`);
  } catch { console.log('💸 Paid (could not decode the receipt header).'); }
}
console.log(`⏳ ${started.message}`);

// Poll the free result URL until the search finishes.
let result;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const r = await fetch(started.poll_url);
  result = await r.json();
  process.stdout.write(`   status: ${result.status}${result.progress ? ' ' + JSON.stringify(result.progress) : ''}      \r`);
  if (result.status === 'completed' || result.status === 'failed') break;
}
console.log('');
if (result?.status !== 'completed') { console.error('❌ Lookup did not complete:', result?.error || 'timed out'); process.exit(1); }

for (const company of result.results || []) {
  console.log(`\n🏢 ${company.company_name || query}`);
  for (const [label, url] of [['X', company.project_x_url], ['Website', company.website_url], ['Telegram channel', company.telegram_channel_url]]) {
    if (url) console.log(`   ${label}: ${url}`);
  }
  for (const m of company.team_members) {
    console.log(`   • ${m.display_name}${m.role ? ` — ${m.role}` : ''} [${m.confidence}]`);
    console.log(`       Telegram: ${m.telegram_url || '(no handle found)'}   X: ${m.x_url || '-'}${m.website_url ? `   Web: ${m.website_url}` : ''}`);
  }
}
console.log(`\n✅ Done in ${Math.round((Date.now() - t0) / 1000)}s`);
