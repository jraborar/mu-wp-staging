-- 008 — Standardize the site key on Pantheon UUID; machine_name = display id.
-- Registers by UUID (already how claybuck/qa-cccu are keyed); re-keys the 4
-- machine-name rows and every table that references `site` across the 3 apps.
-- machine_name is backfilled from terminus `name`; site_name stays the label.
--
-- sites is referenced by FOREIGN KEYs (e.g. vrt_runs_site_fkey), so a plain
-- re-key deadlocks on the constraints. This drops every FK to sites, re-keys,
-- then rebuilds each FK from its captured definition. One transaction — any
-- error rolls the whole thing back.

begin;

-- 0. Display column (idempotent).
alter table public.sites add column if not exists machine_name text;

-- 1. Snapshot every FK that references public.sites, then drop them.
create temp table _fk_backup on commit drop as
select con.conname,
       ns.nspname                    as child_schema,
       cl.relname                    as child_table,
       pg_get_constraintdef(con.oid) as def
from pg_constraint con
join pg_class     cl on cl.oid = con.conrelid
join pg_namespace ns on ns.oid = cl.relnamespace
join pg_class     pl on pl.oid = con.confrelid
where con.contype = 'f'
  and pl.relname = 'sites'
  and pl.relnamespace = 'public'::regnamespace;

do $$
declare r record;
begin
  for r in select * from _fk_backup loop
    execute format('alter table %I.%I drop constraint %I', r.child_schema, r.child_table, r.conname);
  end loop;
end $$;

-- 2. Backfill machine_name for the two sites already keyed by UUID.
update public.sites set machine_name = 'claybuck' where site = '3178761a-1776-4937-9ba6-62cf7ac004cb';
update public.sites set machine_name = 'qa-cccu'  where site = 'fef3980b-2cec-4206-ba62-a9a40c8d606f';

-- 3. Re-key the four machine-name sites (order-independent — FKs are dropped).

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

-- 4. Recreate every FK exactly as it was (children now reference valid UUIDs).
do $$
declare r record;
begin
  for r in select * from _fk_backup loop
    execute format('alter table %I.%I add constraint %I %s', r.child_schema, r.child_table, r.conname, r.def);
  end loop;
end $$;

commit;

-- Verify: every sites row keyed by UUID + has machine_name.
--   select site, machine_name, site_name from public.sites order by machine_name;
