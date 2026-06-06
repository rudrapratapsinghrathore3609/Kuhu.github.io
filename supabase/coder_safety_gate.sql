create table if not exists public.coder_action_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null,
  action_type text not null check (action_type in (
    'read_file',
    'generate_preview',
    'explain_code',
    'write_file',
    'run_command',
    'install_package',
    'delete_file',
    'github_issue',
    'deploy'
  )),
  risk_level text not null check (risk_level in ('safe', 'confirm', 'danger')),
  payload jsonb not null,
  description text not null,
  approved_by_user boolean not null default false,
  rejected boolean not null default false,
  executed boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);

create table if not exists public.coder_audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  proposal_id uuid references public.coder_action_proposals(id) on delete set null,
  action_type text not null,
  risk_level text not null,
  payload jsonb,
  outcome text not null check (outcome in ('approved', 'rejected', 'expired', 'auto_executed')),
  executed_at timestamptz not null default now()
);

create index if not exists coder_action_proposals_user_created_idx
  on public.coder_action_proposals(user_id, created_at desc);
create index if not exists coder_action_proposals_pending_idx
  on public.coder_action_proposals(user_id, expires_at)
  where approved_by_user = false and rejected = false and executed = false;
create index if not exists coder_audit_log_user_executed_idx
  on public.coder_audit_log(user_id, executed_at desc);

alter table public.coder_action_proposals enable row level security;
alter table public.coder_audit_log enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'coder_action_proposals'
      and policyname = 'Users can read own coder proposals'
  ) then
    create policy "Users can read own coder proposals" on public.coder_action_proposals
      for select
      using (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'coder_audit_log'
      and policyname = 'Users can read own coder audit'
  ) then
    create policy "Users can read own coder audit" on public.coder_audit_log
      for select
      using (auth.uid() = user_id);
  end if;
end $$;

grant select on public.coder_action_proposals to authenticated;
grant select on public.coder_audit_log to authenticated;
