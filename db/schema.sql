-- Long2Short — Postgres schema (Railway Postgres addon).
--
-- Run this ONCE against your Railway Postgres database (Railway dashboard →
-- Postgres service → Data tab → paste & run, or `psql $DATABASE_URL -f db/schema.sql`).
-- The app auto-creates these tables on boot too (see lib/dbInit.ts), so this
-- file is the readable reference + the manual fallback.
--
-- Auth here is app-owned: users / sessions in these tables, passwords as
-- bcrypt hashes. There is NO auth.users table and NO row-level security —
-- the app enforces ownership by always scoping queries to the session's user id.

-- ---------------------------------------------------------------------------
-- users — one row per account
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  full_name     text not null default '',
  created_at    timestamptz not null default now()
);

create index if not exists users_email_lower_idx
  on public.users (lower(email));

-- ---------------------------------------------------------------------------
-- sessions — one row per signed-in browser (app-owned session cookie)
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  -- 64 hex chars from crypto.randomBytes(32); stored sha256-hashed
  id         text primary key,
  user_id    uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- sliding expiry; refreshed on every authenticated request
  expires_at timestamptz not null default (now() + interval '30 days')
);

create index if not exists sessions_user_id_idx
  on public.sessions (user_id);

-- ---------------------------------------------------------------------------
-- subscriptions — one row per user, their current plan
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  user_id            uuid primary key references public.users (id) on delete cascade,
  plan               text not null default 'free'
                     check (plan in ('free', 'creator', 'pro')),
  status             text not null default 'active'
                     check (status in ('active', 'cancelled', 'expired')),
  -- last Paystack transaction reference, so we never double-apply a payment
  paystack_ref       text,
  current_period_end timestamptz,
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- usage_events — one row per metered action, used for monthly quotas
-- ---------------------------------------------------------------------------
create table if not exists public.usage_events (
  id         bigserial primary key,
  user_id    uuid not null references public.users (id) on delete cascade,
  -- 'analyze' today; add more kinds later without a migration
  kind       text not null default 'analyze',
  created_at timestamptz not null default now()
);

create index if not exists usage_events_user_kind_created_idx
  on public.usage_events (user_id, kind, created_at desc);

-- ---------------------------------------------------------------------------
-- profiles — kept for backwards-compat with the pre-migration schema
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references public.users (id) on delete cascade,
  email      text,
  full_name  text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- NOTE: video files, rendered clips and voice files are NOT in Postgres — they
-- live on the server's disk under public/uploads/<user_id>/ etc. (see
-- lib/userPaths.ts). Railway volumes persist them across deploys when mounted.
-- ---------------------------------------------------------------------------
