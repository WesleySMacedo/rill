create table if not exists public.rill_missions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_request_id uuid not null,
  task text not null check (char_length(task) between 1 and 2000),
  target_path text not null,
  action text not null,
  domain text not null,
  risk text not null,
  model_profile text not null,
  state text not null,
  approval_required boolean not null default false,
  provider_status text not null default 'NOT_INVOKED',
  selected_model text,
  estimated_cost_usd numeric(12, 8),
  context_manifest jsonb not null default '{}'::jsonb,
  plan jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_request_id)
);

create index if not exists rill_missions_user_created_idx
  on public.rill_missions (user_id, created_at desc);

create table if not exists public.rill_workflow_events (
  event_id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.rill_missions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  state text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (mission_id, event_type)
);

create index if not exists rill_workflow_events_mission_idx
  on public.rill_workflow_events (mission_id, created_at);

create table if not exists public.rill_approvals (
  approval_id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.rill_missions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  decision text not null check (decision in ('PENDING', 'APPROVED', 'REJECTED', 'REQUESTED_CHANGES')),
  decided_by uuid references auth.users(id),
  justification text,
  proposal_hash text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists public.rill_proposal_versions (
  proposal_version_id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.rill_missions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null check (version > 0),
  proposal_hash text not null,
  proposal jsonb not null,
  created_at timestamptz not null default now(),
  unique (mission_id, version),
  unique (mission_id, proposal_hash)
);

create table if not exists public.rill_execution_state (
  mission_id uuid primary key references public.rill_missions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  state text not null,
  execution_gate text not null default 'LOCKED',
  attempt integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.rill_audit_events (
  audit_event_id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references public.rill_missions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  actor_id uuid references auth.users(id),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'rill_missions',
    'rill_workflow_events',
    'rill_approvals',
    'rill_proposal_versions',
    'rill_execution_state',
    'rill_audit_events'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists owner_select on public.%I', table_name);
    execute format('drop policy if exists owner_insert on public.%I', table_name);
    execute format('drop policy if exists owner_update on public.%I', table_name);
    execute format('create policy owner_select on public.%I for select to authenticated using (user_id = (select auth.uid()))', table_name);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
  end loop;
end;
$$;

grant usage, select on all sequences in schema public to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'rill_workflow_events'
    ) then
    alter publication supabase_realtime add table public.rill_workflow_events;
  end if;
end;
$$;