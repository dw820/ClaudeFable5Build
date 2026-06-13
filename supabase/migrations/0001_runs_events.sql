-- AutoCut: runs + events (the Supabase two-way bus between the Vercel UI and the
-- Daytona agent). The UI inserts a run; the agent (subscribed to runs) executes
-- and streams events back; the UI subscribes to events. Demo-scoped RLS.

create extension if not exists pgcrypto;

create table if not exists runs (
  id            uuid primary key default gen_random_uuid(),
  project_id    text,
  brief         text,
  style         text,
  aspect        text,
  target_len_s  int,
  status        text not null default 'queued',  -- queued | running | shipped | failed
  claimed_at    timestamptz,
  shipped_render text,                            -- public Storage URL of the shipped cut
  created_at    timestamptz not null default now()
);

create table if not exists events (
  id          bigint generated always as identity primary key,
  run_id      uuid not null references runs(id) on delete cascade,
  iteration   int,
  phase       text,           -- plan|select|build|render|grade|fix|ship|memory
  message     text,
  scores      jsonb,          -- present on grade events: the dimension scores snapshot
  render_ref  text,
  ts          double precision,
  created_at  timestamptz not null default now()
);

create index if not exists events_run_id_idx on events (run_id, id);

-- Realtime: agent listens on runs (new work), UI listens on events (live feed).
alter publication supabase_realtime add table runs;
alter publication supabase_realtime add table events;

-- Demo RLS: anon can read everything and insert a run; the service role (agent +
-- /api/generate) does the rest. Tighten before any real multi-user use.
alter table runs enable row level security;
alter table events enable row level security;

create policy "demo read runs"   on runs   for select using (true);
create policy "demo insert runs" on runs   for insert with check (true);
create policy "demo read events" on events for select using (true);

-- Storage bucket for rendered videos (public read for the demo).
insert into storage.buckets (id, name, public)
values ('renders', 'renders', true)
on conflict (id) do nothing;
