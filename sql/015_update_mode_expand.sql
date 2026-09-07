-- Expand the update_mode check constraint to cover the full set of named
-- Pantheon upstream types. The original constraint only had 3 values;
-- this adds drops7, drupal8, empty, drupal-composer, and drupal9 so
-- each upstream variant is represented distinctly in the UI.
--
-- Under the hood the staging mechanism is still derived by detectProfile
-- (terminus probe), so this is a labelling change only.

alter table sites drop constraint if exists sites_update_mode_check;

alter table sites add constraint sites_update_mode_check
  check (update_mode in (
    'upstream',        -- Pantheon Upstream (WP, WP Multisite)
    'drops7',          -- Drops 7 (Drupal 7, Pantheon upstream)
    'composer',        -- Integrated Composer (drupal-composer-managed, IC)
    'drupal8',         -- Drupal 8 (drops-8 upstream, drush mechanism)
    'empty',           -- Empty upstream (behaves like drops-8)
    'drupal-composer', -- Drupal with Composer (drupal-project, IC-like, deprecated)
    'drupal9',         -- Drupal 9 (drupal-recommended, IC-like, deprecated)
    'none'             -- No core updates
  ));

-- Backfill existing Drupal sites to correct update_mode values (2026-09-07 audit)
update sites set update_mode = 'composer'
  where machine_name in ('bcbs-vermont','cemsed9','marietta-college-v3','tulsalib','umary-online','umary-prime-matters');

update sites set update_mode = 'drupal-composer'
  where machine_name = 'hfu';                   -- drupal-project upstream

update sites set update_mode = 'empty'
  where machine_name = 'inst';                  -- empty upstream, drops-8 behaviour

update sites set update_mode = 'drupal9'
  where machine_name = 'saddlebackd9';          -- drupal-recommended upstream

update sites set update_mode = 'drupal8'
  where machine_name = 'micheal-watson-secretary-of-state'; -- drops-8 upstream

update sites set update_mode = 'drops7'
  where machine_name = 'scph';                  -- drops-7 upstream
