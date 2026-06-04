create extension if not exists vector;
create extension if not exists pg_trgm;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table public.ai_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  provider text not null check (provider in ('openai', 'openrouter', 'gemini', 'groq', 'together', 'ollama', 'compatible')),
  base_url text not null,
  model text not null,
  api_key_encrypted text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.agents (
  id text primary key,
  name text not null,
  role text not null,
  system_prompt text not null,
  created_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id text not null references public.agents(id),
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id text not null references public.agents(id),
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content jsonb not null,
  created_at timestamptz not null default now()
);

create table public.uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  file_name text not null,
  mime_type text not null,
  byte_size integer not null,
  storage_path text not null,
  extracted_text text,
  created_at timestamptz not null default now()
);

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id text not null references public.agents(id),
  category text not null,
  learning text not null,
  source_message_id uuid references public.messages(id) on delete set null,
  confidence numeric not null default 0.7,
  embedding vector(1536),
  created_at timestamptz not null default now(),
  unique (user_id, agent_id, category, learning)
);

create table public.search_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id text references public.agents(id),
  source_type text not null check (source_type in ('message', 'memory', 'upload')),
  source_id uuid not null,
  title text not null,
  body text not null,
  embedding vector(1536),
  created_at timestamptz not null default now()
);

create index conversations_user_agent_idx on public.conversations(user_id, agent_id, updated_at desc);
create index messages_conversation_idx on public.messages(conversation_id, created_at);
create index memories_user_agent_idx on public.memories(user_id, agent_id, created_at desc);
create index search_documents_trgm_idx on public.search_documents using gin (body gin_trgm_ops);
create index memories_embedding_idx on public.memories using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index search_documents_embedding_idx on public.search_documents using ivfflat (embedding vector_cosine_ops) with (lists = 100);

alter table public.profiles enable row level security;
alter table public.ai_accounts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.uploads enable row level security;
alter table public.memories enable row level security;
alter table public.search_documents enable row level security;

create policy "Profiles are personal" on public.profiles
  using (auth.uid() = id) with check (auth.uid() = id);

create policy "AI accounts are personal" on public.ai_accounts
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Conversations are personal" on public.conversations
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Messages are personal" on public.messages
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Uploads are personal" on public.uploads
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Memories are personal" on public.memories
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Search docs are personal" on public.search_documents
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Agents are readable" on public.agents
  for select using (true);

insert into storage.buckets (id, name, public)
values ('kuhu-uploads', 'kuhu-uploads', false)
on conflict (id) do nothing;

create policy "Users can read own uploads" on storage.objects
  for select using (
    bucket_id = 'kuhu-uploads'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can upload own files" on storage.objects
  for insert with check (
    bucket_id = 'kuhu-uploads'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can delete own uploads" on storage.objects
  for delete using (
    bucket_id = 'kuhu-uploads'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

insert into public.agents (id, name, role, system_prompt) values
  ('jarvis', 'Jarvis', 'Chief Supervisor', 'Coordinate all specialist agents, plan priorities, and route work to the right agent. Learn user goals and operating style.'),
  ('nova', 'Nova', 'News and General Knowledge', 'Explain current affairs, general knowledge, history, science, and context. Learn interests and knowledge gaps.'),
  ('phil', 'Phil', 'Market Research and R&D', 'Analyze companies, products, markets, competitors, and opportunities. Learn industries and research standards.'),
  ('mastermind', 'Mastermind', 'Finance and Stock Market', 'Teach investing, economics, finance, and risk. Learn the user financial education level.'),
  ('homelander', 'Homelander', 'Skill Learning and Tracking', 'Create roadmaps, milestones, quizzes, and accountability. Learn progress and practice patterns.'),
  ('noir', 'Noir', 'Studies and Academics', 'Explain concepts, summarize notes, create practice questions, and build revision plans. Learn subjects and weak areas.'),
  ('kuhu', 'Kuhu', 'Website Agent', 'Help build and improve websites with UX, copy, SEO, performance, and launch planning. Learn product decisions.'),
  ('sage', 'Sage', 'Wisdom and Quotes', 'Share wisdom, quotes, interpretations, and reflective prompts. Learn favorite themes and thinkers.')
on conflict (id) do update set
  name = excluded.name,
  role = excluded.role,
  system_prompt = excluded.system_prompt;

create or replace function public.match_memories(
  query_embedding vector(1536),
  match_user_id uuid,
  match_agent_id text,
  match_count int default 8
)
returns table (
  id uuid,
  category text,
  learning text,
  similarity float
)
language sql stable
as $$
  select
    memories.id,
    memories.category,
    memories.learning,
    1 - (memories.embedding <=> query_embedding) as similarity
  from public.memories
  where memories.user_id = match_user_id
    and memories.agent_id = match_agent_id
    and memories.embedding is not null
  order by memories.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function public.keyword_search(
  search_user_id uuid,
  search_agent_id text,
  query text,
  match_count int default 10
)
returns table (
  id uuid,
  source_type text,
  title text,
  body text,
  rank real
)
language sql stable
as $$
  select
    id,
    source_type,
    title,
    body,
    similarity(body, query) as rank
  from public.search_documents
  where user_id = search_user_id
    and (agent_id = search_agent_id or agent_id is null)
    and body % query
  order by rank desc
  limit match_count;
$$;
