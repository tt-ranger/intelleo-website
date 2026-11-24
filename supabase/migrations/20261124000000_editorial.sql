create schema if not exists editorial;
revoke all on schema editorial from public;

create table if not exists editorial.events (
  id text primary key,
  title text not null,
  keywords text[] not null,
  event_at timestamptz,
  first_seen timestamptz not null default now()
);

create table if not exists editorial.sources (
  url text primary key,
  event_id text references editorial.events(id),
  title text not null,
  publisher text not null,
  published_at timestamptz,
  source_type text not null check (source_type in ('primary', 'independent', 'syndicated', 'community')),
  content_hash text not null,
  excerpts jsonb not null,
  fetched_at timestamptz not null default now()
);
create index if not exists editorial_sources_event_idx on editorial.sources(event_id, published_at desc);
create index if not exists editorial_sources_fetch_idx on editorial.sources(fetched_at);

create table if not exists editorial.assessments (
  url text not null,
  content_hash text not null,
  rubric text not null,
  verdict jsonb not null,
  assessed_at timestamptz not null default now(),
  primary key (url, content_hash, rubric)
);

create table if not exists editorial.slots (
  id text primary key,
  editorial_day date not null,
  mode text not null check (mode in ('shadow', 'live')),
  state text not null check (state in ('new', 'qualified', 'opened', 'merged', 'published', 'missed')),
  expires_at timestamptz not null,
  cluster text,
  event_id text,
  slug text,
  draft jsonb,
  pr integer,
  head text,
  merge_sha text,
  deploy_retries integer not null default 0,
  reason text,
  updated_at timestamptz not null default now()
);
create index if not exists editorial_slots_day_idx on editorial.slots(editorial_day, mode, state);

create table if not exists editorial.reserve (
  id text primary key,
  cluster text not null,
  draft jsonb not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create table if not exists editorial.leases (
  name text primary key,
  holder text not null,
  until_at timestamptz not null
);

create table if not exists editorial.refreshes (
  id text primary key,
  finished_at timestamptz not null default now()
);

create table if not exists editorial.budgets (
  editorial_day date primary key,
  model_micros integer not null default 0 check (model_micros >= 0)
);

create table if not exists editorial.model_calls (
  id text primary key,
  editorial_day date not null references editorial.budgets(editorial_day),
  model text not null,
  reserved_micros integer not null,
  charged_micros integer,
  provider_id text,
  started_at timestamptz not null default now()
);

create table if not exists editorial.search_calls (
  editorial_day date not null,
  provider text not null check (provider in ('brave', 'you')),
  used integer not null check (used between 1 and 12),
  primary key (editorial_day, provider)
);

create table if not exists editorial.settings (
  name text primary key,
  value jsonb not null
);
