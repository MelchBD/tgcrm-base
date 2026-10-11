# TGcrm on Base

**AI agents pay per Telegram-handle lookup in USDC — and humans buy lookup packs the same way. Both settle on Base.**

[TGcrm](https://tgcrm.xyz) is a Telegram-native CRM for crypto founders and BD teams. Its **TG Finder** feature finds the
Telegram handles (plus X profiles and websites) of the people behind a project. This repo is the code we built for
Colosseum's **Crypto World's Fair** to put that on Base:

| | What it does | Who pays | How |
|---|---|---|---|
| **Agent payments** | `POST /x402/tg-finder/lookup` — any AI agent or script pays **$1 USDC** per lookup and gets the result. No signup, no API key. | An AI agent (its own wallet) | [x402](https://docs.cdp.coinbase.com/x402/welcome.md) on Base, settled by Coinbase's CDP facilitator |
| **Lookup packs** | A Pro user buys **10 lookups for $10 USDC** inside TGcrm. | A person | [Base Pay](https://docs.cdp.coinbase.com/coinbase-wallet/guides/accept-payments.md) (`@base-org/account`) |

Try the agent side live: **https://app.tgcrm.xyz/x402**

## Proof — real USDC on Base mainnet

Both features have been run end to end with real money:

- **Agent paid for a lookup (x402):** [`0x90ed285e…c28ede`](https://basescan.org/tx/0x90ed285e4fbf430e3d8ff99d7d01dd6db4250ee6bb93a4e65891a5cf3bc28ede) — 1.00 USDC from the agent's wallet to the TGcrm wallet.
- **Pro user bought a pack (Base Pay):** [`0xa9eb92eb…a5369`](https://basescan.org/tx/0xa9eb92eb3873aed8b200860db6278cc11829ed6dcb4ee11032b86f30bb5a5369) — 10.004401 USDC. Base Pay is a smart-wallet payment, so this transaction is an ERC-4337 *bundle* with other people's transfers in it; find the 10.004401 USDC transfer to our wallet in its token transfers.
- **Receiving wallet:** [`0xed37…e354`](https://basescan.org/address/0xed37a3659c9c6b28b5d86dac12dd78ab54e355e8) (`melch1.base.eth`) — a non-custodial wallet. **No private key is ever stored on the server;** it only knows this public address.

## Why this exists

Crypto deals are negotiated on Telegram, and finding the right person's handle is the slow part of BD. TG Finder already
did that for people. Agents are the next customer: they can't fill in a checkout form, but they *can* pay an HTTP 402. And
for people, USDC on Base is a one-tap checkout with no card form and no chargebacks.

## How the agent flow works (x402)

```
agent ── POST /x402/tg-finder/lookup {"query":"uniswap.org"} ─────────────▶ TGcrm
agent ◀─ 402 Payment Required  (price, USDC, Base, pay-to address) ───────── TGcrm
agent signs a USDC payment and retries with it
TGcrm ── verify ──▶ Coinbase CDP facilitator           (payment is valid)
TGcrm starts the TG Finder search                      (if this fails: HTTP 503 and NOTHING is charged)
TGcrm ── settle ──▶ facilitator                        USDC moves onchain on Base
agent ◀─ 200 { search_id, poll_url } + payment receipt
agent ── GET poll_url (free) ──▶ { status:"completed", results:[ handles, X profiles, websites ] }
```

- **A failed lookup is never charged.** The x402 middleware settles only if the handler returns a status < 400.
- **Fails closed.** Until the payment middleware is ready, the route answers `503`; the paid handler is unreachable without it.
- **Checks run *before* asking for money:** input validation and an hourly/daily spend guard (every lookup costs real credits on the shared TG Finder account).
- Results are served from a signed, purpose-scoped token, so an agent can only read its own lookup.
- The agent needs **only USDC** — no ETH for gas.

Run the demo agent (it has hard spend caps: $1.50 per payment, $5 per day):

```bash
npm install
export CDP_API_KEY_ID=… CDP_API_KEY_SECRET=… CDP_WALLET_SECRET=…   # from portal.cdp.coinbase.com
node scripts/x402-agent-demo.mjs --faucet                  # testnet: fund the agent with free test USDC
node scripts/x402-agent-demo.mjs uniswap.org               # Base Sepolia (testnet)
node scripts/x402-agent-demo.mjs uniswap.org --mainnet     # Base mainnet — real USDC
```

## How the pack purchase works (Base Pay)

```
browser: tick "All purchases are final — no refunds" ─▶ POST /api/usdc/order
server : reserves an order, returns the EXACT amount to pay (price + a sub-cent order code, e.g. 10.004401)
browser: Base Pay wallet popup ─▶ USDC moves on Base
browser: POST /api/usdc/claim { order_id, payment_id }
server : verifies the payment ONCE, onchain ─▶ credits +10 lookups ─▶ Telegram receipt
```

The browser's "payment succeeded" is never trusted. The server verifies, and these rules are covered by tests:

- **Order code.** A transaction id is public the moment it's mined, so without this anyone could claim someone else's payment. Every order has a unique amount; only the order whose exact amount was paid can claim it. An amount is never reissued for 24 h.
- **Exact verification.** `getPaymentStatus` must show a USDC transfer from the payer **to our address for the exact amount**.
- **Single use.** `usdc_orders.tx_hash` is `UNIQUE`, and an order flips unpaid → paid atomically. A payment can never buy two orders.
- **Grant once.** A lock (`credits_granted_at`) is taken before credits are added; five concurrent claims credit exactly once, and a failed grant releases the lock and alerts the admin.
- **Retrying never locks a user out.** A new order replaces the old unpaid one. A replaced or expired order stays claimable for 24 h, so someone who paid and closed the tab is still credited — and only they can claim it.
- **Free lookup first.** Pro includes one free lifetime lookup; it's spent before purchased credits, and the UI shows `Lookups left: 10 + 1 free`.
- **No refunds**, stated before payment, in the receipt, and on `/x402`.

The wallet SDK is served from our own server (a pinned npm package), not a third-party CDN, on the page that takes people's money.

## Repo layout

```
src/config.js          env-driven config; defaults to TESTNET so a missing variable can never move real money
src/x402Lookup.js      agent endpoint: validation + spend guard → x402 payment → TG Finder lookup → token-gated results
src/usdcPacks.js       Pro packs: /api/usdc/packs, /order, /claim, and the self-hosted SDK route
src/tgfinderBatch.js   TG Finder API client + result summariser (shared by the app and the agent endpoint)
client/                browser half of the pack purchase (excerpt from TGcrm's frontend)
scripts/               the demo agent
sql/schema.sql         tables/columns the features need (idempotent)
test/                  35 backend tests (in-memory database + fake payment verifier)
```

## Mounting it

TGcrm's Express server wires the modules in with a few lines (the server itself is private):

```js
import { getBaseConfig } from './src/config.js';
import { mountX402Lookup } from './src/x402Lookup.js';
import { mountUsdcPacks } from './src/usdcPacks.js';

const config = getBaseConfig();   // reads the env vars in .env.example
mountX402Lookup(app, { config, supabase, signJwt, verifyJwt, appUrl, tgFinder: { apiKey, apiBase }, alertAdmin });
mountUsdcPacks(app, { config, supabase, requireAuthJwtOnly, sendBotMsg, openAppButton, logEvent, alertAdmin });
```

Each feature turns itself off (and logs why) if its environment variables are missing, and a failure in either never
affects the rest of the app. `signJwt(payload)` / `verifyJwt(token, expectedPurpose)` are host-provided; tokens with a
`purpose` claim only verify where that purpose is asked for.

## Tests

```bash
npm install && npm test      # 35 tests, no network or wallet needed
```

They cover pricing/config defaults, orders, claims, replay, wrong amount/recipient, late claims, concurrency, the grant
failure path, fail-closed x402 behaviour, and the result summariser. The credit accounting was also exercised end to end
against the full TGcrm server (with a fake database and TG Finder), and both payment flows were run on testnet and then on mainnet.

## Honest limits

- The spend guard counts in memory, so it resets when the server restarts (it only protects our TG Finder credits).
- One pack size and one price are configurable by env var, not yet by plan.
- x402 takes one lookup per request; batch pricing could use x402's `upto` scheme.
- Base Pay is one-time payments here; subscriptions stay on Stripe.

## Built with

Base mainnet USDC · [x402](https://docs.cdp.coinbase.com/x402/welcome.md) + the Coinbase CDP facilitator · Base Pay (`@base-org/account`) · Node/Express · Supabase.

---

© 2026 TGcrm. All rights reserved. Published for hackathon review — see [LICENSE](LICENSE).
