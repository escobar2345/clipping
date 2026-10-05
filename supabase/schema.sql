-- Long2Short — Supabase schema
--
-- Run this once in the Supabase SQL Editor (or `supabase db push`) BEFORE the
-- app needs billing. Supabase Auth itself needs no SQL — only these two tables
-- and their RLS policies.
--
-- Security model: every table has Row Level Security on, and every policy is
-- scoped to `auth.uid()`. That means even if a bug leaked a user's session,
-- the database still refuses to hand them anyone else's rows.

-- ---------------------------------------------------------------------------
-- subscriptions — one row per user, their current plan
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  plan               text not null default 'free'
                       check (plan in ('free', 'creator', 'pro')),
  status             text not null default 'active'
                       check (status in ('active', 'cancelled', 'expired')),
  -- last Paystack transaction reference, so we never double-apply a payment
  paystack_ref       text,
  current_period_end timestamptz,
  updated_at         timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

-- A user may read their own subscription…
create policy "users can read their own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- …but can NEVER write it. Upgrades happen only through the Paystack webhook,
-- which uses the service-role key and so bypasses RLS by design. Without this
-- policy anyone could grant themselves the Pro plan with a curl request.
create policy "users can insert their own free subscription"
  on public.subscriptions for insert
  with check (auth.uid() = user_id and plan = 'free');

-- ---------------------------------------------------------------------------
-- usage_events — one row per metered action, used for monthly quotas
-- ---------------------------------------------------------------------------
create table if not exists public.usage_events (
  id         bigserial primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- 'analyze' today; add more kinds later without a migration
  kind       text not null default 'analyze',
  created_at timestamptz not null default now()
);

create index if not exists usage_events_user_kind_created_idx
  on public.usage_events (user_id, kind, created_at desc);

alter table public.usage_events enable row level security;

create policy "users can read their own usage"
  on public.usage_events for select
  using (auth.uid() = user_id);

create policy "users can log their own usage"
  on public.usage_events for insert
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- profiles — display name, created on first sign-in
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  full_name  text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "users can read their own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Automatically give every new auth user a `free` subscription and a profile.
-- This is the only path that inserts a subscription row on the user's behalf.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.subscriptions (user_id, plan, status)
  values (new.id, 'free', 'active')
  on conflict (user_id) do nothing;

  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- NOTE: video files, rendered clips and voice files are NOT in Supabase — they
-- live on the server's disk under public/uploads/<user_id>/ etc. (see
-- lib/userPaths.ts). If you later deploy to Vercel, move those to Supabase
-- Storage or S3, because the serverless filesystem is read-only.
-- ---------------------------------------------------------------------------