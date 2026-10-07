-- Apply this migration in the Supabase SQL Editor for the project configured in Railway.
-- Safe to re-run: policies are replaced and the table is created only if missing.

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free'
    check (plan in ('free', 'creator', 'pro')),
  status text not null default 'active'
    check (status in ('active', 'cancelled', 'expired')),
  paystack_ref text,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

drop policy if exists "users can read their own subscription"
  on public.subscriptions;
create policy "users can read their own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);

drop policy if exists "users can insert their own free subscription"
  on public.subscriptions;
create policy "users can insert their own free subscription"
  on public.subscriptions for insert
  with check (auth.uid() = user_id and plan = 'free');

grant select, insert on public.subscriptions to authenticated;
grant all on public.subscriptions to service_role;

notify pgrst, 'reload schema';
