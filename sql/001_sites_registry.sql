-- ============================================================================
-- Shared Sites registry — single source of truth for mu-wp-staging + mu-deployment.
-- Run once in the Supabase SQL editor (project vcobiyidhkazhujzowhw).
-- Keyed by Pantheon machine-name. Platform-aware from day one. Guardrails in-DB.
-- ============================================================================

create table if not exists public.sites (
  site                text        primary key,                    -- Pantheon machine-name = canonical shared id
  site_name           text,                                       -- human label (terminus site:info)
  platform            text        not null default 'wp-single'
                        check (platform in ('wp-single','wp-multisite','drupal')),
  parent_site         text        references public.sites(site) on delete cascade,  -- multisite/drupal child (phase 5)
  php_version         text        check (php_version is null or php_version ~ '^\d+\.\d+$'),
  upstream            text,
  skip_upstream       boolean     not null default false,         -- blanket update/deploy defaults
  skip_plugins_themes boolean     not null default false,
  deploy_days         integer     not null default 1 check (deploy_days >= 0),
  deploy_destination  text        not null default 'live'
                        check (deploy_destination in ('dev','test','live','multidev')),
  vrt_paths           text[]      not null default '{}'           -- relative URL paths for visual regression (phase 4 VRT)
                        check (array_length(vrt_paths, 1) is null or array_length(vrt_paths, 1) <= 70),
  active              boolean     not null default true,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- guardrail: auto-touch updated_at on every update
create or replace function public.set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists sites_set_updated_at on public.sites;
create trigger sites_set_updated_at before update on public.sites
  for each row execute function public.set_updated_at();

create index if not exists sites_parent_idx   on public.sites(parent_site);
create index if not exists sites_platform_idx on public.sites(platform);

-- ── Backfill from existing tables (idempotent) ──────────────────────────────
insert into public.sites (site, site_name, skip_upstream, skip_plugins_themes, deploy_days, deploy_destination)
select distinct on (site)
       site, site_name,
       coalesce(skip_upstream, false), coalesce(skip_plugins_themes, false),
       coalesce(deploy_days, 1), coalesce(deploy_destination, 'live')
from public.staging_schedules
on conflict (site) do nothing;

insert into public.sites (site)
select distinct site from public.site_update_prefs
on conflict (site) do nothing;

-- php_version is filled afterward by the one-time terminus pass (POST /api/sites/backfill-php).
