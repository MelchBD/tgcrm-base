-- Schema for the Base payment features. Idempotent: safe to run more than once.
-- (TGcrm already has `users` and `tg_finder_searches`; these statements extend them.)

-- Purchased TG Finder lookups (spent AFTER the one free lifetime lookup).
alter table users add column if not exists tg_finder_credits integer not null default 0;

-- Marks searches paid for by an agent (x402, user_id is NULL) or with purchased credits.
alter table tg_finder_searches add column if not exists paid_search boolean not null default false;

-- One row per USDC pack order. The unique amount (price + sub-cent "order code") is what ties
-- a public onchain payment to exactly one order; tx_hash UNIQUE makes a payment single-use.
create table if not exists usdc_orders (
  id                 bigint generated always as identity primary key,
  telegram_id        bigint not null,
  pack               text not null,
  credits            integer not null,
  amount_usdc        numeric(18,6) not null,
  network            text not null,                       -- 'base' | 'base-sepolia'
  status             text not null default 'pending',     -- pending | superseded | expired | paid
  tx_hash            text unique,                         -- Base Pay payment id (ERC-4337 userOp hash)
  payer              text,
  created_at         timestamptz not null default now(),
  paid_at            timestamptz,
  credits_granted_at timestamptz                          -- set atomically BEFORE crediting: grant-once lock
);
create index if not exists usdc_orders_user_idx on usdc_orders(telegram_id, status);

alter table usdc_orders enable row level security;
drop policy if exists usdc_orders_service_all on usdc_orders;
create policy usdc_orders_service_all on usdc_orders for all to service_role using (true) with check (true);
