-- One active staging schedule per site.
--
-- `scph` accumulated THREE active schedules, all monthly/day_of_week=4/
-- week_of_month=4 and all pointing at next_staging_at = 2026-09-24T07:00Z.
-- Two of them were created 16 seconds apart (18:43:34 and 18:43:50 on
-- 2026-08-27) — a double-submit, not a deliberate configuration. Neither
-- carried deploy_days or deploy_destination, and neither had ever run
-- (last_staged_at was null on both).
--
-- WHY IT MATTERED. It is not a concurrency bug: runDueJobs() already defers a
-- second run per site, both on the in-memory job store (getAllJobs) and on
-- hasRunForMultidev(). The damage is quieter. getActiveSchedules() has no
-- ORDER BY, so when several rows for one site are due in the same tick,
-- whichever one Postgres happens to return first is the row whose
-- deploy_days and deploy_destination get handed to createJob(). For scph that
-- was a coin flip between deploy_days = 1 (the real row) and null — and null
-- falls through to MU_DEPLOY_SCHEDULE_DAYS, which is '3' in production. So the
-- customer's one-business-day deploy window would silently become three,
-- nondeterministically, on a site whose destination is `live`.
--
-- The two duplicate rows have already been deleted from production; the delete
-- below is written so this file is still correct if it is ever replayed on a
-- database that has them.

begin;

-- Deterministic keeper: a row that has actually fired wins over one that never
-- has, and the earliest creation breaks the remaining tie. For scph this picks
-- the 07:16 row — the only one with last_staged_at, deploy_days and
-- deploy_destination set.
with ranked as (
  select id,
         row_number() over (
           partition by site
           order by (last_staged_at is null), created_at
         ) as rn
  from public.staging_schedules
  where active
)
delete from public.staging_schedules
where id in (select id from ranked where rn > 1);

-- Partial, so retiring a schedule (active = false, as a 'once' cadence does
-- after it fires) never blocks creating its replacement — only one *live*
-- schedule per site is enforced.
create unique index if not exists staging_schedules_one_active_per_site
  on public.staging_schedules (site)
  where active;

commit;

comment on index public.staging_schedules_one_active_per_site is
  'One active schedule per site. Without it a double-submitted create leaves several rows due in the same tick, and getActiveSchedules() has no ORDER BY — so which row supplies deploy_days/deploy_destination is nondeterministic.';
