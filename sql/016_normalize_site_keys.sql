-- Normalize sites registered with a Pantheon UUID as the primary key.
-- Early registrations stored the Pantheon site UUID directly in `sites.site`
-- (the primary key) instead of the machine name. This caused getSite() to
-- fail when called with a machine name, routing those sites to the WordPress
-- staging path even when they are Drupal.
--
-- Steps:
--   1. Backfill site_uuid from site for UUID-keyed records.
--   2. Update staging_history.site and staging_schedules.site references.
--   3. Update vrt_runs.site references.
--   4. Update the sites.site primary key to the machine name.
--
-- Run after deploying the corresponding app changes (getSite machine_name
-- fallback + anchor advance on no-update run).

-- 1. Backfill site_uuid
update sites
set site_uuid = site
where site ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and machine_name is not null
  and (site_uuid is null or site_uuid = '');

-- 2a. staging_history — update site references before changing the PK
update staging_history sh
set site = s.machine_name
from sites s
where sh.site = s.site
  and s.site ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and s.machine_name is not null;

-- 2b. staging_schedules — update site references
update staging_schedules ss
set site = s.machine_name
from sites s
where ss.site = s.site
  and s.site ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and s.machine_name is not null;

-- 3. vrt_runs — update site references
update vrt_runs vr
set site = s.machine_name
from sites s
where vr.site = s.site
  and s.site ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and s.machine_name is not null;

-- 4. Update the primary key itself (no FK constraints on child tables)
update sites
set site = machine_name
where site ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and machine_name is not null;
