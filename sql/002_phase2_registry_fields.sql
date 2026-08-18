-- ============================================================================
-- Phase 2 registry fields (run once in the Supabase SQL editor).
-- Adds site-level facts from the old-PMU review + deploy-timing knobs.
-- skip_upstream / skip_plugins_themes already exist (sql/001) and stay on `sites`
-- as the source of truth (runUpstreamCheck already reads them there).
-- ============================================================================

alter table public.sites
  add column if not exists update_mode text not null default 'upstream'
    check (update_mode in ('upstream', 'composer', 'none'));

alter table public.sites
  add column if not exists deploy_approval text not null default 'manual'
    check (deploy_approval in ('manual', 'auto'));

alter table public.sites
  add column if not exists security_deploy_hours integer not null default 24
    check (security_deploy_hours >= 0);

alter table public.sites
  add column if not exists site_uuid text;

-- update_mode='composer' or 'none' implies the site does not take Pantheon upstream.
-- Backfill skip_upstream from any site already flagged as not-upstream is a no-op here
-- (defaults keep existing behavior); set per-site via the Sites tab.
