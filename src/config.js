// Base (Coinbase's L2) payments — configuration.
//
// Everything is env-driven so the exact same code runs against Base Sepolia
// (testnet, fake USDC) and Base mainnet (real USDC). Defaults are TESTNET on
// purpose: forgetting to set a variable must never move real money.
//
//   X402_ENV              'development' (Base Sepolia, default) | 'production' (Base mainnet)
//   X402_PAY_TO           address that receives agent (x402) payments
//   USDC_NETWORK          'base-sepolia' (default) | 'base'   — Pro lookup packs (Base Pay)
//   USDC_PAY_TO           address that receives pack payments (falls back to X402_PAY_TO)
//   CDP_API_KEY_ID / CDP_API_KEY_SECRET   Coinbase Developer Platform keys (x402 facilitator)
//   TGF_LOOKUP_PRICE_USD  price of one agent lookup (default 1.00)
//   TGF_PACK_LOOKUPS / TGF_PACK_PRICE_USDC   Pro pack size / price (default 10 for 10.00)
//   X402_MAX_PER_HOUR / X402_MAX_PER_DAY     spend guard on the shared TG Finder account

export const NETWORKS = {
  'base': {
    caip2: 'eip155:8453', testnet: false,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    explorer: 'https://basescan.org', label: 'Base',
  },
  'base-sepolia': {
    caip2: 'eip155:84532', testnet: true,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorer: 'https://sepolia.basescan.org', label: 'Base Sepolia (testnet)',
  },
};

export const FINAL_SALE_NOTICE = 'All purchases are final — no refunds.';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRICE_RE   = /^\d{1,4}(\.\d{1,6})?$/;

const intEnv = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : dflt; };
const priceEnv = (v, dflt) => (typeof v === 'string' && PRICE_RE.test(v.trim()) && parseFloat(v) > 0 ? v.trim() : dflt);

// "10.00" → 10000000n (micro-USDC, USDC has 6 decimals). Exact: no floats.
export function toMicro(amountStr) {
  const [whole, frac = ''] = String(amountStr).split('.');
  return BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
}

// 10003417n → "10.003417"
export function fromMicro(micro) {
  const m = BigInt(micro);
  return `${m / 1_000_000n}.${String(m % 1_000_000n).padStart(6, '0')}`;
}

export function getBaseConfig(env = process.env) {
  const x402Production = env.X402_ENV === 'production';
  const x402NetworkKey = x402Production ? 'base' : 'base-sepolia';
  const x402PayTo = env.X402_PAY_TO || env.USDC_PAY_TO || '';

  const packNetworkKey = NETWORKS[env.USDC_NETWORK] ? env.USDC_NETWORK : 'base-sepolia';
  const packPayTo = env.USDC_PAY_TO || env.X402_PAY_TO || '';

  const priceUsd = priceEnv(env.TGF_LOOKUP_PRICE_USD, '1.00');

  return {
    x402: {
      // Needs CDP keys (facilitator auth) + a receiving address. Anything missing → feature off, app unaffected.
      enabled: env.X402_ENABLED !== 'false' && !!env.CDP_API_KEY_ID && !!env.CDP_API_KEY_SECRET && ADDRESS_RE.test(x402PayTo),
      environment: x402Production ? 'production' : 'development',
      networkKey: x402NetworkKey,
      network: NETWORKS[x402NetworkKey],
      payTo: x402PayTo,
      priceUsd,
      maxPerHour: intEnv(env.X402_MAX_PER_HOUR, 20),
      maxPerDay: intEnv(env.X402_MAX_PER_DAY, 100),
    },
    packs: {
      enabled: env.USDC_PACKS_ENABLED !== 'false' && ADDRESS_RE.test(packPayTo),
      networkKey: packNetworkKey,
      network: NETWORKS[packNetworkKey],
      payTo: packPayTo,
      items: [{
        id: 'tgf_pack',
        lookups: intEnv(env.TGF_PACK_LOOKUPS, 10),
        priceUsdc: priceEnv(env.TGF_PACK_PRICE_USDC, '10.00'),
      }],
    },
  };
}
