-- 010 — Auto-staging opt-in gate. A site is only auto-staged (by the upstream
-- scan, the scheduled lane, or the security lane) when auto_stage = true. Default
-- FALSE = opt-in: registering a site (e.g. for VRT) never enrolls it in automated
-- staging — the consultant flips this on per-site when the site is ready. Distinct
-- from skip_upstream (which only controls whether the upstream STEP runs when we do
-- stage). Fixes silent surprise-staging of merely-registered sites.
alter table public.sites add column if not exists auto_stage boolean default false;
