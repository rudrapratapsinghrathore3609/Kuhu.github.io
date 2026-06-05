create table if not exists public.ai_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null default current_date,
  request_count integer not null default 0,
  token_estimate integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

alter table public.ai_daily_usage enable row level security;

drop policy if exists "Daily usage is personal" on public.ai_daily_usage;
create policy "Daily usage is personal" on public.ai_daily_usage
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.increment_ai_daily_usage(
  target_user_id uuid,
  request_increment integer default 1,
  token_increment integer default 0
)
returns table(request_count integer, token_estimate integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or auth.uid() <> target_user_id then
    raise exception 'not allowed';
  end if;

  insert into public.ai_daily_usage (user_id, usage_date, request_count, token_estimate)
  values (target_user_id, current_date, greatest(request_increment, 0), greatest(token_increment, 0))
  on conflict (user_id, usage_date)
  do update set
    request_count = public.ai_daily_usage.request_count + greatest(request_increment, 0),
    token_estimate = public.ai_daily_usage.token_estimate + greatest(token_increment, 0),
    updated_at = now();

  return query
  select u.request_count, u.token_estimate
  from public.ai_daily_usage u
  where u.user_id = target_user_id and u.usage_date = current_date;
end;
$$;

grant execute on function public.increment_ai_daily_usage(uuid, integer, integer) to authenticated;

create index if not exists ai_daily_usage_date_idx on public.ai_daily_usage(usage_date desc);
