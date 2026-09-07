-- Normalize sites registered with a Pantheon UUID as the primary key.
-- Early registrations stored the Pantheon site UUID directly in `sites.site`
-- (the primary key) instead of the machine name. This caused getSite() to
-- fail when called with a machine name, routing those sites to the WordPress
-- staging path even when they are Drupal.
--
-- vrt_runs.site has a FK constraint on sites.site, so we must update
-- sites.site first and then update vrt_runs. staging_history and
-- staging_schedules have no FK constraint so order is flexible.
-- We drop and recreate the vrt_runs FK to avoid the PK-update cascade issue.
--
-- Run after deploying the corresponding app changes (getSite machine_name
-- fallback + anchor advance on no-update run).

-- 1. Backfill site_uuid from site for UUID-keyed records
update sites
set site_uuid = site
where site ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and machine_name is not null
  and (site_uuid is null or site_uuid = '');

-- 2. Drop the FK so we can update both sides independently
alter table vrt_runs drop constraint if exists vrt_runs_site_fkey;

-- 3. Update the sites.site primary key to machine_name
update sites
set site = machine_name
where site ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and machine_name is not null;

-- 4. Update child tables now that sites.site has machine_name values

-- staging_history (no FK constraint)
update staging_history sh
set site = s.machine_name
from sites s
where sh.site = s.site_uuid
  and s.site_uuid is not null
  and s.machine_name is not null;

-- staging_schedules (no FK constraint)
update staging_schedules ss
set site = s.machine_name
from sites s
where ss.site = s.site_uuid
  and s.site_uuid is not null
  and s.machine_name is not null;

-- vrt_runs — sites.site is now machine_name, so FK check will pass
update vrt_runs vr
set site = s.machine_name
from sites s
where vr.site = s.site_uuid
  and s.site_uuid is not null
  and s.machine_name is not null;

-- 5. Recreate the FK constraint
alter table vrt_runs
  add constraint vrt_runs_site_fkey
  foreign key (site) references sites(site);
