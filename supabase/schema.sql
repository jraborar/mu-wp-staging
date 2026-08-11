-- Run this in your Supabase SQL editor

create table if not exists staging_history (
  id                      uuid primary key default gen_random_uuid(),
  site                    text not null,
  site_name               text,
  multidev                text not null,
  upstream                text,
  upstream_updated        boolean not null default false,
  upstream_skipped_reason text,
  plugins_updated         jsonb not null default '[]',
  plugins_skipped         jsonb not null default '[]',
  themes_updated          jsonb not null default '[]',
  themes_skipped          jsonb not null default '[]',
  status                  text not null,
  started_at              timestamptz not null,
  completed_at            timestamptz,
  logs                    jsonb not null default '[]'
);

create index on staging_history (site, started_at desc);
create index on staging_history (multidev);
create index on staging_history (status);

-- Row-level security (enable after configuring your service role key)
-- alter table staging_history enable row level security;

-- Per-site plugin/theme skip preferences
-- Configure once, applies to all staging runs (manual, scheduled, automated)
create table if not exists site_update_prefs (
  site         text primary key,
  plugin_skips text[] not null default '{}',
  theme_skips  text[] not null default '{}',
  updated_at   timestamptz not null default now()
);
