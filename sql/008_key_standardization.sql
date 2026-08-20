-- 008 — Standardize the site key on Pantheon UUID; machine_name becomes the display id.
-- Registers by UUID (already how clayendbuck/qa-cccu are keyed); re-keys the 4
-- machine-name rows and every table that references `site` across the 3 apps.
-- machine_name is backfilled from terminus `name`; site_name stays the friendly label.
--
-- Run once in Supabase. Wrapped in a transaction — all-or-nothing.
-- No FK constraints are expected on these text columns; if one errors, stop and tell me.

begin;

-- 1. New display column.
alter table public.sites add column if not exists machine_name text;

-- 2. Backfill machine_name for the two sites already keyed by UUID.
update public.sites set machine_name = 'claybuck' where site = '3178761a-1776-4937-9ba6-62cf7ac004cb';
update public.sites set machine_name = 'qa-cccu'  where site = 'fef3980b-2cec-4206-ba62-a9a40c8d606f';

-- 3. Re-key the four machine-name sites to their UUID across every referencing table,
--    then the sites row itself (also stamping machine_name).

-- achi -> 2f6f1d1f-acc7-4a29-800c-e56700262e44
update public.staging_history       set site = '2f6f1d1f-acc7-4a29-800c-e56700262e44' where site = 'achi';
update public.staging_schedules     set site = '2f6f1d1f-acc7-4a29-800c-e56700262e44' where site = 'achi';
update public.site_update_prefs     set site = '2f6f1d1f-acc7-4a29-800c-e56700262e44' where site = 'achi';
update public.scheduled_deployments set site = '2f6f1d1f-acc7-4a29-800c-e56700262e44' where site = 'achi';
update public.vrt_runs              set site = '2f6f1d1f-acc7-4a29-800c-e56700262e44' where site = 'achi';
update public.sites set site = '2f6f1d1f-acc7-4a29-800c-e56700262e44', machine_name = 'achi' where site = 'achi';

-- apexorderpickup -> af617d7f-010f-4ac7-a34a-02ad1195ebc9
update public.staging_history       set site = 'af617d7f-010f-4ac7-a34a-02ad1195ebc9' where site = 'apexorderpickup';
update public.staging_schedules     set site = 'af617d7f-010f-4ac7-a34a-02ad1195ebc9' where site = 'apexorderpickup';
update public.site_update_prefs     set site = 'af617d7f-010f-4ac7-a34a-02ad1195ebc9' where site = 'apexorderpickup';
update public.scheduled_deployments set site = 'af617d7f-010f-4ac7-a34a-02ad1195ebc9' where site = 'apexorderpickup';
update public.vrt_runs              set site = 'af617d7f-010f-4ac7-a34a-02ad1195ebc9' where site = 'apexorderpickup';
update public.sites set site = 'af617d7f-010f-4ac7-a34a-02ad1195ebc9', machine_name = 'apexorderpickup' where site = 'apexorderpickup';

-- bowside-capital -> 4aca72ea-cd92-4187-8d03-344b8066ccf1
update public.staging_history       set site = '4aca72ea-cd92-4187-8d03-344b8066ccf1' where site = 'bowside-capital';
update public.staging_schedules     set site = '4aca72ea-cd92-4187-8d03-344b8066ccf1' where site = 'bowside-capital';
update public.site_update_prefs     set site = '4aca72ea-cd92-4187-8d03-344b8066ccf1' where site = 'bowside-capital';
update public.scheduled_deployments set site = '4aca72ea-cd92-4187-8d03-344b8066ccf1' where site = 'bowside-capital';
update public.vrt_runs              set site = '4aca72ea-cd92-4187-8d03-344b8066ccf1' where site = 'bowside-capital';
update public.sites set site = '4aca72ea-cd92-4187-8d03-344b8066ccf1', machine_name = 'bowside-capital' where site = 'bowside-capital';

-- leadingage-wp -> 466f6619-85de-4e29-9348-99986d02e20a
update public.staging_history       set site = '466f6619-85de-4e29-9348-99986d02e20a' where site = 'leadingage-wp';
update public.staging_schedules     set site = '466f6619-85de-4e29-9348-99986d02e20a' where site = 'leadingage-wp';
update public.site_update_prefs     set site = '466f6619-85de-4e29-9348-99986d02e20a' where site = 'leadingage-wp';
update public.scheduled_deployments set site = '466f6619-85de-4e29-9348-99986d02e20a' where site = 'leadingage-wp';
update public.vrt_runs              set site = '466f6619-85de-4e29-9348-99986d02e20a' where site = 'leadingage-wp';
update public.sites set site = '466f6619-85de-4e29-9348-99986d02e20a', machine_name = 'leadingage-wp' where site = 'leadingage-wp';

commit;

-- Verify: every sites row keyed by UUID + has machine_name.
--   select site, machine_name, site_name from public.sites order by machine_name;
