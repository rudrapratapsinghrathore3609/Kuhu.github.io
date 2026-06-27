create table if not exists public.ai_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null default current_date,
  request_count integer not null default 0,
  token_estimate integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

alter table public.ai_daily_usage enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'ai_daily_usage'
      and policyname = 'Users can read own AI daily usage'
  ) then
    create policy "Users can read own AI daily usage" on public.ai_daily_usage
      for select
      using (auth.uid() = user_id);
  end if;
end $$;

grant select on public.ai_daily_usage to authenticated;

drop function if exists public.increment_ai_daily_usage(uuid, integer, integer);

create function public.increment_ai_daily_usage(
  target_user_id uuid,
  request_increment integer default 1,
  token_increment integer default 0
)
returns table (
  user_id uuid,
  usage_date date,
  request_count integer,
  token_estimate integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if auth.uid() <> target_user_id then
    raise exception 'Cannot increment usage for another user';
  end if;

  insert into public.ai_daily_usage as usage (
    user_id,
    usage_date,
    request_count,
    token_estimate,
    updated_at
  )
  values (
    target_user_id,
    current_date,
    greatest(request_increment, 0),
    greatest(token_increment, 0),
    now()
  )
  on conflict (user_id, usage_date)
  do update set
    request_count = usage.request_count + greatest(request_increment, 0),
    token_estimate = usage.token_estimate + greatest(token_increment, 0),
    updated_at = now();

  return query
    select usage.user_id, usage.usage_date, usage.request_count, usage.token_estimate
    from public.ai_daily_usage usage
    where usage.user_id = target_user_id
      and usage.usage_date = current_date;
end;
$$;

grant execute on function public.increment_ai_daily_usage(uuid, integer, integer) to authenticated;
