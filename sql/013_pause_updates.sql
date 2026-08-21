-- 013 — First-class pause for managed updates.
--
-- Until now "paused" meant unticking auto_stage, which is indistinguishable from
-- "never onboarded": no reason, no expected end, nothing to remind anyone to
-- follow up. That is the wrong shape for a customer-requested hold — a D10→D11
-- migration can run for months, across people, and someone will eventually ask
-- why a site stopped updating.
--
-- Pause is deliberately ORTHOGONAL to auto_stage: a paused site stays armed, so
-- resuming is one click and we still know it was enrolled.
--
--   paused_at         when the hold started — drives the age shown in the UI
--   paused_until      the EXPECTED end. Optional: plenty of customers give no
--                     timeline, and chasing one is consultant discretion. This
--                     date does NOT auto-resume the site; it drives the 3
--                     business-day warning and then an overdue state, because a
--                     hold that quietly ends mid-migration is the failure we are
--                     trying to prevent.
--   pause_reason      free text, shown on the site row
--   pause_notified_at last reminder sent, so the scheduler nudges rather than spams
alter table public.sites add column if not exists paused_at         timestamptz;
alter table public.sites add column if not exists paused_until      date;
alter table public.sites add column if not exists pause_reason      text;
alter table public.sites add column if not exists pause_notified_at timestamptz;

comment on column public.sites.paused_until is
  'Expected end of the hold. Advisory only — the site stays paused until a human resumes it.';
