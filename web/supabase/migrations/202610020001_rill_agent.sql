-- Rill Agent: device-code pairing, registered machines and personal tokens.
-- Secrets are never stored in clear text: device codes, user codes and tokens are sha256 hashes.

create table if not exists public.rill_agent_pairings (
  pairing_id uuid primary key default gen_random_uuid(),
  device_code_hash text not null unique,
  user_code_hash text not null unique,
  machine_name text not null check (char_length(machine_name) between 1 and 120),
  platform text not null check (char_length(platform) between 1 and 60),
  agent_version text not null check (char_length(agent_version) between 1 and 40),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'DENIED', 'CONSUMED')),
  user_id uuid references auth.users(id) on delete cascade,
  decided_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists rill_agent_pairings_expires_idx
  on public.rill_agent_pairings (expires_at);

create table if not exists public.rill_agent_machines (
  machine_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  machine_name text not null check (char_length(machine_name) between 1 and 120),
  platform text not null check (char_length(platform) between 1 and 60),
  agent_version text not null check (char_length(agent_version) between 1 and 40),
  workspace_count integer not null default 0 check (workspace_count >= 0),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists rill_agent_machines_user_idx
  on public.rill_agent_machines (user_id, created_at desc);

create table if not exists public.rill_personal_tokens (
  token_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  machine_id uuid not null references public.rill_agent_machines(machine_id) on delete cascade,
  token_hash text not null unique,
  token_prefix text not null,
  scope text not null default 'agent' check (scope in ('agent')),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists rill_personal_tokens_machine_idx
  on public.rill_personal_tokens (machine_id);

-- Machines are visible to their owner; pairings and tokens are reachable by the service role only.
alter table public.rill_agent_machines enable row level security;
drop policy if exists owner_select on public.rill_agent_machines;
create policy owner_select on public.rill_agent_machines
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.rill_agent_machines from anon, authenticated;
grant select on public.rill_agent_machines to authenticated;
grant all on public.rill_agent_machines to service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['rill_agent_pairings', 'rill_personal_tokens'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from anon, authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
  end loop;
end;
$$;
