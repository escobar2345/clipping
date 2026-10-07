import { getPool } from "./db";

/**
 * Ensures the Postgres tables exist. Runs once per server boot
 * (called from instrumentation.ts) and again from /api/health's `?migrate=1`
 * escape hatch, so a fresh Railway Postgres volume self-heals.
 *
 * Plain `create table if not exists` — no migration framework needed yet.
 * If the database is unreachable this logs and returns; the app stays up so
 * /api/health can still report what's wrong.
 */

let done = false;

const STATEMENTS = [
  `create table if not exists public.users (
     id            uuid primary key default gen_random_uuid(),
     email         text not null unique,
     password_hash text not null,
     full_name     text not null default '',
     created_at    timestamptz not null default now()
   )`,
  `create index if not exists users_email_lower_idx on public.users (lower(email))`,
  `create table if not exists public.sessions (
     id         text primary key,
     user_id    uuid not null references public.users (id) on delete cascade,
     created_at timestamptz not null default now(),
     expires_at timestamptz not null default (now() + interval '30 days')
   )`,
  `create index if not exists sessions_user_id_idx on public.sessions (user_id)`,
  `create table if not exists public.subscriptions (
     user_id            uuid primary key references public.users (id) on delete cascade,
     plan               text not null default 'free'
                        check (plan in ('free', 'creator', 'pro')),
     status             text not null default 'active'
                        check (status in ('active', 'cancelled', 'expired')),
     paystack_ref       text,
     current_period_end timestamptz,
     updated_at         timestamptz not null default now()
   )`,
  `create table if not exists public.usage_events (
     id         bigserial primary key,
     user_id    uuid not null references public.users (id) on delete cascade,
     kind       text not null default 'analyze',
     created_at timestamptz not null default now()
   )`,
  `create index if not exists usage_events_user_kind_created_idx on public.usage_events (user_id, kind, created_at desc)`,
  `create table if not exists public.profiles (
     id         uuid primary key references public.users (id) on delete cascade,
     email      text,
     full_name  text,
     created_at timestamptz not null default now()
   )`,
];

export async function ensureTables(): Promise<void> {
  if (done) return;
  done = true;
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    console.warn("[db] DATABASE_URL/PGHOST not set — skipping table check.");
    return;
  }
  try {
    const pool = getPool();
    for (const sql of STATEMENTS) {
      await pool.query(sql);
    }
    // Sweep expired sessions so the table doesn't grow forever.
    await pool.query("delete from public.sessions where expires_at < now()");
  } catch (err: any) {
    console.warn(`[db] table check failed (will retry on next call): ${err?.message ?? err}`);
    done = false;
  }
}
