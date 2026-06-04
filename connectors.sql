create table if not exists public.connectors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  type text not null check (type in ('memory_search', 'web_search', 'google_drive', 'local_files', 'custom_api')),
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.connector_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id uuid references public.connectors(id) on delete set null,
  query text not null,
  status text not null check (status in ('ok', 'error', 'skipped')),
  result_count int not null default 0,
  error text,
  created_at timestamptz not null default now()
);

alter table public.connectors enable row level security;
alter table public.connector_runs enable row level security;

drop policy if exists "Connectors are personal" on public.connectors;
create policy "Connectors are personal" on public.connectors
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Connector runs are personal" on public.connector_runs;
create policy "Connector runs are personal" on public.connector_runs
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists connectors_user_enabled_idx on public.connectors(user_id, enabled, type);
create index if not exists connector_runs_user_created_idx on public.connector_runs(user_id, created_at desc);