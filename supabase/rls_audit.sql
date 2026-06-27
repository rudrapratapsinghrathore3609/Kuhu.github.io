-- Run this in the Supabase SQL editor before sharing the app.
-- Expected result: every row should show rls_status = enabled and policy_count > 0.

with critical_tables(table_name) as (
  values
    ('profiles'),
    ('ai_accounts'),
    ('conversations'),
    ('messages'),
    ('uploads'),
    ('memories'),
    ('search_documents'),
    ('connectors'),
    ('connector_runs'),
    ('ai_daily_usage'),
    ('coder_action_proposals'),
    ('coder_audit_log')
),
table_status as (
  select
    c.table_name,
    case
      when cls.oid is null then 'missing'
      when cls.relrowsecurity then 'enabled'
      else 'disabled'
    end as rls_status
  from critical_tables c
  left join pg_namespace ns on ns.nspname = 'public'
  left join pg_class cls on cls.relname = c.table_name and cls.relnamespace = ns.oid
),
policy_status as (
  select
    c.table_name,
    count(p.policyname) as policy_count,
    string_agg(p.policyname, ', ' order by p.policyname) as policies
  from critical_tables c
  left join pg_policies p
    on p.schemaname = 'public'
   and p.tablename = c.table_name
  group by c.table_name
)
select
  t.table_name,
  t.rls_status,
  p.policy_count,
  coalesce(p.policies, 'none') as policies,
  case
    when t.rls_status = 'enabled' and p.policy_count > 0 then 'ready'
    else 'fix before inviting users'
  end as launch_status
from table_status t
join policy_status p using (table_name)
order by
  case when t.rls_status = 'enabled' and p.policy_count > 0 then 1 else 0 end,
  t.table_name;
