-- sql/020: security_fast_track — flip to "on by default + opt-outs"
-- ============================================================================
-- PURPOSE
--   PR #322 makes the scheduler HONOR staging_schedules.security_fast_track
--   (introduced inert in sql/019 with DEFAULT false). All 31 prod rows are
--   currently false, so the instant #322 deploys, automated CVE fast-track
--   goes dark for every currently-eligible site. Chosen policy is
--   ON BY DEFAULT + explicit OPT-OUTS:
--     (a) flip the column DEFAULT to true  -> future schedules fast-track
--         unless a human opts them out;
--     (b) backfill the currently-eligible PRODUCTION rows to true;
--     (c) deliberately LEAVE the known opt-outs false;
--     (d) arm the dormant non-opt-out sites (decision 2026-10-13, Part 4).
--
-- ORDERING CONSTRAINT  (read before applying)
--   Apply this migration BEFORE merging PR #322. mu-staging auto-deploys on
--   merge to main, and #322's merge is what activates the honoring code — if
--   the data isn't flipped first, there is a window where fast-track is dead
--   for all 12 eligible sites. Order: apply 020 -> confirm verification query
--   -> then merge #322.
--
-- APPLY  This migration is applied MANUALLY via the approval path (Supabase SQL
--   editor, project vcobiyidhkazhujzowhw). It is NEVER run against production
--   from an agent. This is a one-time DDL + data backfill, not a new runtime
--   writer — mu-staging and mu-deployment remain the only writers of this table.
--
-- LOCK  Part 1 (ALTER … SET DEFAULT) takes a brief ACCESS EXCLUSIVE lock on
--   staging_schedules to update the catalog default. It is metadata-only: NO
--   table rewrite and NO scan of existing rows. Sub-millisecond on 31 rows.
--
-- KEY CHOICE  Rows are scoped by `site` (the Pantheon machine-name slug), not
--   by UUID. `site` is the canonical shared identifier across all four MU apps
--   (primary key of public.sites), it is human-auditable in review, and the
--   unique index `staging_schedules_one_active_per_site` (sql/017) guarantees
--   at most ONE active row per site — so `where site = '…' and active` resolves
--   to exactly the row confirmed below. Confirmed UUIDs are kept in comments
--   for traceability. Every UPDATE is guarded with
--   `security_fast_track is distinct from true` so re-apply is a no-op.
-- ============================================================================

begin;

-- ── Part 1: new rows fast-track by default ──────────────────────────────────
-- Idempotent: SET DEFAULT is declarative.
alter table public.staging_schedules
  alter column security_fast_track set default true;

-- ── Part 2: backfill the 8 currently-eligible PRODUCTION sites ──────────────
-- Confirmed 2026-10-13: each row active=true, site.auto_stage=true,
-- site.paused=false, deploy_destination='live', security_fast_track=false.
--   bowside-capital  422464a6-1bf6-40ca-94d6-fa1e14cfc2b6
--   apexorderpickup  dce6d4fe-67f3-4c79-b60e-91848f04a727
--   urban-grid       134f053b-5ceb-426e-9044-e5bea98d2692
--   spire-ri         289409f0-c7dd-4553-9056-e4e6c225fd3f
--   claybuck         c7f09e0c-c07c-4c90-91bb-bb3af8395294  (monthly)
--   scph             31535de6-5fb4-4372-b475-00f98e92f58d  (monthly)
--   achi             ca6e2317-9314-4a88-948d-93da5832da57
--   cccu-globaled    d9352476-beb1-4f66-a81a-d54e11be322a
update public.staging_schedules
set security_fast_track = true
where active
  and security_fast_track is distinct from true
  and site in (
    'bowside-capital',
    'apexorderpickup',
    'urban-grid',
    'spire-ri',
    'claybuck',
    'scph',
    'achi',
    'cccu-globaled'
  );
-- Expected: 8 rows updated on first apply, 0 on replay.

-- ── Part 3: OPT-OUTS — deliberately left false (NO UPDATE below) ────────────
-- These four are currently eligible (active + auto_stage=true) but are
-- INTENTIONALLY excluded from the backfill. They are documented here, not
-- updated, so that this exclusion is explicit and survives review/replay:
--   riverbed-new   0d5a44e8-555d-4b1b-858d-fd2d80e9d828  cad=bimonthly-week-of-15,
--                  dest=multidev — deliberate bimonthly opt-out / Defect B storm
--                  site; must NOT fast-track.
--   leadingage-wp  d1f36933-69a5-47e3-a0d8-d7792c74eb90  dest=test  — non-prod.
--   qa-cccu        219a3975-5bf7-4363-bacd-5e6933a9759a  dest=live  — non-prod QA.
--   lgla-merge     aeaa4830-558b-4aab-9389-189fe145f8e3  dest=live  — non-prod merge.
-- Their rows remain security_fast_track = false (and sql/019's old DEFAULT
-- false already applied to them). No statement acts on them. Intentional.

commit;

-- ── Part 4: arm the 19 dormant non-opt-out sites ────────────────────────────
-- INCLUDED per decision 2026-10-13 (user chose "arm them"). These are active=true
-- SCHEDULE rows whose SITE is currently dormant (auto_stage=false and/or paused).
-- Arming them is INERT until a site is reactivated; it prevents a silent CVE
-- fast-track gap on later resume. NOTE: this touches PAUSED CUSTOMER sites'
-- config for behaviour that only takes effect if/when they are resumed.
-- Dormant set confirmed 2026-10-13 (31 total − 12 eligible = 19):
--   baseball-hall-of-fame, bcbs-vermont, blue-cross(paused), cemsed9(dev),
--   fia-tech(test), hcc-main(paused), hfu, inst,
--   marietta-college-v3(paused), mercyhome-primary(paused),
--   micheal-watson-secretary-of-state, niacc, policyed1, saddlebackd9,
--   simplisafe-press-room(paused), tstc-multisite, tulsalib,
--   umary-online(paused), umary-prime-matters(paused)
begin;
update public.staging_schedules
set security_fast_track = true
where active
  and security_fast_track is distinct from true
  and site in (
    'baseball-hall-of-fame',
    'bcbs-vermont',
    'blue-cross',
    'cemsed9',
    'fia-tech',
    'hcc-main',
    'hfu',
    'inst',
    'marietta-college-v3',
    'mercyhome-primary',
    'micheal-watson-secretary-of-state',
    'niacc',
    'policyed1',
    'saddlebackd9',
    'simplisafe-press-room',
    'tstc-multisite',
    'tulsalib',
    'umary-online',
    'umary-prime-matters'
  );
-- Expected: 19 rows updated on first apply.
commit;
-- ============================================================================

-- ── VERIFICATION — run AFTER apply, BEFORE merging #322 ─────────────────────
-- 1) Default is now true:
--   select column_default
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name   = 'staging_schedules'
--     and column_name  = 'security_fast_track';
--   -- expect: true
--
-- 2) The 8 prod rows are true and the 4 opt-outs are still false:
--   select site, active, deploy_destination, security_fast_track
--   from public.staging_schedules
--   where site in (
--     'bowside-capital','apexorderpickup','urban-grid','spire-ri',
--     'claybuck','scph','achi','cccu-globaled',
--     'riverbed-new','leadingage-wp','qa-cccu','lgla-merge'
--   )
--   order by security_fast_track desc, site;
--   -- expect: the 8 prod sites true; riverbed-new, leadingage-wp, qa-cccu,
--   --         lgla-merge false.
--
-- 3) Full tally (dormant block IS included in this migration):
--   select security_fast_track, count(*)
--   from public.staging_schedules
--   group by security_fast_track
--   order by 1;
--   -- expect: true = 27, false = 4   (only the 4 opt-outs remain false)
