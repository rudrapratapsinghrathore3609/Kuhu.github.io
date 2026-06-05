-- Advanced AI Agents features: shared workspaces, feedback, scheduled tasks, and file RAG.
-- Applied to project rduhruycdvrvmyksamhz on 2026-06-05.

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Shared workspace',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'editor' check (role in ('admin','editor','viewer')),
  status text not null default 'invited' check (status in ('invited','active','removed')),
  created_at timestamptz not null default now(),
  unique(workspace_id, email)
);

create table if not exists public.response_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid,
  message_id uuid,
  agent_id text not null,
  rating integer not null check (rating in (-1, 1)),
  topic text,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.scheduled_agent_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id text not null,
  title text not null,
  prompt text not null,
  schedule_label text not null default 'Manual',
  cron text,
  enabled boolean not null default true,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id text,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.response_feedback enable row level security;
alter table public.scheduled_agent_tasks enable row level security;
alter table public.document_chunks enable row level security;

create index if not exists workspaces_owner_idx on public.workspaces(owner_user_id, updated_at desc);
create index if not exists workspace_members_workspace_idx on public.workspace_members(workspace_id, status);
create index if not exists response_feedback_agent_idx on public.response_feedback(user_id, agent_id, created_at desc);
create index if not exists scheduled_agent_tasks_user_idx on public.scheduled_agent_tasks(user_id, enabled, next_run_at);
create index if not exists document_chunks_user_agent_idx on public.document_chunks(user_id, agent_id, created_at desc);
create index if not exists document_chunks_content_fts_idx on public.document_chunks using gin(to_tsvector('english', content));

create or replace function public.search_document_chunks(
  search_user_id uuid,
  search_agent_id text,
  query text,
  match_count integer default 8
)
returns table(id uuid, upload_id uuid, content text, metadata jsonb, rank real)
language sql
stable
set search_path = public
as $$
  select dc.id, dc.upload_id, dc.content, dc.metadata,
    ts_rank(to_tsvector('english', dc.content), plainto_tsquery('english', query)) as rank
  from public.document_chunks dc
  where dc.user_id = search_user_id
    and (dc.agent_id = search_agent_id or dc.agent_id is null or search_agent_id is null)
    and dc.content @@ plainto_tsquery('english', query)
  order by rank desc, dc.created_at desc
  limit match_count;
$$;
