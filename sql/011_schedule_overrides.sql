-- 011 — Schedule overrides for the run-now cadence (PR-2 hardening).
--
-- Due-ness is now COMPUTED from the cadence + the site's `last_deployment` anchor
-- (see lib/cadence.ts) instead of read from `staging_schedules.next_staging_at`,
-- which becomes a display projection. That means the Upcoming tab can no longer
-- express "skip this one" / "move this one" by pushing that timestamp around — the
-- computed predicate ignores it — so those intents get their own columns:
--
--   override_at — an explicit pin ("this occurrence only"). Fires at that moment
--                 regardless of cadence parity, then is cleared by the run.
--   skip_week   — Monday (Manila) of an ISO week the user skipped. Suppresses the
--                 cadence for that week only; parity is untouched, so the cycle
--                 resumes on its next on-parity week.
alter table public.staging_schedules add column if not exists override_at timestamptz;
alter table public.staging_schedules add column if not exists skip_week    date;

comment on column public.staging_schedules.override_at is
  'Explicit one-shot pin from the Upcoming tab — fires at this moment regardless of cadence parity, cleared once fired.';
comment on column public.staging_schedules.skip_week is
  'Monday (Manila) of an ISO week to skip. Suppresses that week only; cadence parity is unaffected.';
