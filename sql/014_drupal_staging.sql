-- 014 — Drupal staging support.
--
-- Drupal (Composer-managed) runs reuse the existing per-run columns wherever the
-- shape already fits, so the History tab needs almost no new storage:
--   • Drupal core    → upstream_updated + upstream_old_version/new_version
--                      (rendered "Drupal (x to y)" instead of "WordPress (x to y)")
--   • contrib modules → plugins_updated   (UpdatedItem[] — same {name,title,from,to})
--   • contrib themes  → themes_updated    (UpdatedItem[])
--
-- Only two Drupal-specific things have no existing home:
--   • composer_deps_updated — non-module/theme Composer packages (symfony, guzzle,
--     the drush stack, …) that moved in the lock. Same UpdatedItem[] shape.
--   • security_advisories   — advisories found by `composer audit`, INCLUDING ones on
--     exact-pinned packages we deliberately did NOT touch (reported, never force-fixed).
--
-- `platform` lets the UI pick Drupal vs WordPress labelling without inferring it.
alter table public.staging_history
  add column if not exists platform               text,
  add column if not exists composer_deps_updated  jsonb,
  add column if not exists security_advisories     jsonb;

comment on column public.staging_history.platform is
  'Site platform for this run (drupal | wp-single | wp-multisite). Drives History labelling.';
comment on column public.staging_history.composer_deps_updated is
  'Drupal only: non-module/non-theme Composer packages that changed in composer.lock (UpdatedItem[]).';
comment on column public.staging_history.security_advisories is
  'Drupal only: composer-audit advisories. Includes advisories on exact-pinned packages left untouched (reported, not fixed).';
