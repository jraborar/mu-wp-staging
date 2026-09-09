-- Reconcile the eight settings where `sites` and `staging_schedules` disagree.
--
-- Surfaced by mu-pmu-tool's per-site conflicts panel, which is the first thing
-- that could show a divergence at all — a cross-site list cannot, because the
-- comparison is per row pair. Audited 2026-09-09 across all 28 registry rows
-- against their active schedule (28 schedules, exactly one active each, none
-- with two — 017 holds).
--
-- ═══ WHICH SIDE ACTUALLY WINS ═══════════════════════════════════════════════
-- This is the whole reason the eight rows are not one problem but three, and
-- it is not symmetric. Measured, not assumed:
--
--   scheduled run — runDueJobs(), lib/scheduler.ts:
--     skipUpstream       site.skip_upstream ?? sched.skip_upstream
--     skipPluginsThemes  site.skip_plugins_themes ?? sched.skip_plugins_themes
--     deployDays         sched.deploy_days
--     deployDestination  sched.deploy_destination
--
--   manual run — POST /api/staging with the field omitted, then
--   prebookDeployment()/computeScheduledFor(), lib/schedule.ts:
--     deployDays         job.deployDays ?? site.deploy_days ?? env
--     deployDestination  job.deployDestination || site.deploy_destination || env
--
-- So:
--  * skip_upstream / skip_plugins_themes ALWAYS resolve to the registry.
--    `sites.skip_upstream` is `not null default false` (sql/001), so the `??`
--    never falls through and the schedule's copy is dead data on this path.
--  * deploy_days / deploy_destination split BY TRIGGER — schedule when the
--    scheduler fires, registry when a human starts the run.
--  * and runDueJobs() bails on `if (!site?.auto_stage) continue`, so on an
--    auto_stage-off site the scheduler never fires at all and the registry
--    wins unconditionally. Four of the six affected sites are in that state,
--    which is why their schedule rows are dead data rather than live conflicts.
--
-- Every statement below is a data fix. No schema changes, nothing to roll
-- forward in code. Written to be idempotent and replay-safe: each update
-- names both the site and the value it expects to be replacing, so a replay
-- on an already-fixed (or hand-edited) database is a no-op rather than a
-- silent overwrite of someone's later decision.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. skip_upstream: clear the registry flag on five sites ────────────────
-- All five carried sites.skip_upstream = true against a schedule saying false.
-- Because the registry always wins here, the schedules asking for upstream
-- were being ignored.
--
-- On the three auto_stage sites this was a live bug with two heads: the
-- scheduled run skipped the upstream step, AND runUpstreamCheck() drops the
-- site from the off-week scan entirely (`eligible` filters on
-- `!s.skip_upstream`). So they had no automatic route to a core update at all.
-- The history says people noticed and did it by hand — leadingage-wp 9 times,
-- apexorderpickup 8, bowside-capital 5, the last being leadingage-wp's
-- 7.0.4 → 7.1 on 2026-08-21. Clearing the flag is what those runs were
-- working around.
--
--   leadingage-wp    auto_stage on   next window 2026-09-22
--   apexorderpickup  auto_stage on   next window 2026-09-15
--   bowside-capital  auto_stage on   next window 2026-09-14
--
-- achi and qa-cccu are auto_stage-off, so for them the flag was never
-- suppressing a scheduled run — it was seeding mu-staging's Stage form, which
-- loads the registry value as the checkbox default (app/page.tsx, `skip_upstream:
-- s.skip_upstream ?? false  // site fact (registry)`). An operator opening the
-- dialog saw "skip upstream" pre-checked and had to notice and untick it. Both
-- sites have applied upstream by hand anyway (achi 4 runs, qa-cccu 1), so the
-- pre-check was working against the intent every time. They are included here
-- as the same decision at lower risk: no scheduled run changes, only the
-- default an operator is offered.
update public.sites
   set skip_upstream = false
 where site in ('leadingage-wp', 'apexorderpickup', 'bowside-capital', 'achi', 'qa-cccu')
   and skip_upstream is true;

-- ── 2. apexorderpickup deploy window: 2 business days ─────────────────────
-- The only row of the eight where both sides were live at once. Weekly
-- cadence, auto_stage on: the scheduled run read sched.deploy_days = 2 while
-- any manual run read sites.deploy_days = 3. Same site, two different deploy
-- dates depending on who started it.
--
-- 2 is the contracted window and it is also what has been happening — the
-- eight deploys on record all came from scheduled runs. Moving the registry
-- rather than the schedule keeps observed behaviour and fixes the manual path.
update public.sites
   set deploy_days = 2
 where site = 'apexorderpickup'
   and deploy_days = 3;

-- ── 3. tulsalib: retire a dead schedule value ─────────────────────────────
-- sites.deploy_days = 2 vs sched.deploy_days = 3, auto_stage off. The
-- scheduler never fires this site, so all five deploys on record went through
-- the manual path on the registry's 2. The schedule's 3 has never been read
-- and would only start being read if auto_stage were turned on.
update public.staging_schedules
   set deploy_days = 2
 where site = 'tulsalib'
   and active
   and deploy_days = 3;

-- ── 4. riverbed-new: defuse the destination ───────────────────────────────
-- sites.deploy_destination = 'multidev' vs sched.deploy_destination = 'live'.
--
-- The registry is right and deliberate: prebookDeployment() returns early on
-- `job.deployDestination === 'multidev'`, so nothing is ever booked, and the
-- site has 0 deploys on record across 3 staging runs. That is the configuration
-- working as intended — updates are staged to a multidev and go no further.
--
-- The schedule row is the hazard. It is inert only because auto_stage is off.
-- The day anyone flips auto_stage on for this site, runDueJobs() starts reading
-- sched.deploy_destination and a site configured never to leave multidev would
-- begin deploying straight to production. Aligning it now means that switch is
-- safe to throw.
update public.staging_schedules
   set deploy_destination = 'multidev'
 where site = 'riverbed-new'
   and active
   and deploy_destination = 'live';

-- ── what is deliberately NOT touched ──────────────────────────────────────
-- The 21 `default-drift` rows — 19 sites where sites.deploy_days is still
-- sql/001's `default 1` against a schedule of 2 or 3, plus fia-tech and
-- cemsed9 where sites.deploy_destination is the default 'live' against a
-- schedule of 'test'/'dev'.
--
-- These are not misconfigurations in the same sense: one column was never
-- written, which is a different fact from two columns being set to different
-- things. But they are NOT harmless either, and the earlier belief that they
-- were rested on "the schedule is the one that runs" — true only for a
-- scheduled run. A hand-started stage on any of the 19 books its deploy on the
-- untouched `default 1` instead of the schedule's 2 or 3, and a hand-started
-- stage on fia-tech deploys to 'live' where its schedule says 'test'.
--
-- Backfilling 21 rows is a bigger, separate change: it needs the contracted
-- window confirmed per site rather than copied from a schedule row, and
-- fia-tech/cemsed9 need someone to say out loud whether a manual run on them
-- should reach production. Left for that pass.

commit;

-- ── verify ────────────────────────────────────────────────────────────────
-- Expect zero rows. Mirrors configConflicts() in mu-pmu-tool
-- (lib/domain/console.ts), both-set only.
--
-- select s.site, 'skip_upstream' as field, s.skip_upstream::text, sc.skip_upstream::text
--   from public.sites s
--   join public.staging_schedules sc on sc.site = s.site and sc.active
--  where s.skip_upstream is distinct from sc.skip_upstream
--    and s.skip_upstream is not false
-- union all
-- select s.site, 'deploy_days', s.deploy_days::text, sc.deploy_days::text
--   from public.sites s
--   join public.staging_schedules sc on sc.site = s.site and sc.active
--  where s.deploy_days is distinct from sc.deploy_days
--    and s.deploy_days <> 1
-- union all
-- select s.site, 'deploy_destination', s.deploy_destination, sc.deploy_destination
--   from public.sites s
--   join public.staging_schedules sc on sc.site = s.site and sc.active
--  where s.deploy_destination is distinct from sc.deploy_destination
--    and s.deploy_destination <> 'live';
