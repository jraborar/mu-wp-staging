-- Phase 4 (VRT) — engine run records.
-- Each row is one VRT run: the site's per-path targets captured against the
-- live reference base and a candidate (multidev) base, diffed per path.
-- results jsonb: [{path,label,threshold,mismatch_pct,flagged,baseline_url,candidate_url,diff_url,error}]
-- Screenshots live in the Supabase Storage bucket `vrt-screenshots` (created
-- programmatically by mu-vrt on first run).
-- Idempotent: safe to run more than once.

create table if not exists public.vrt_runs (
  id              uuid primary key default gen_random_uuid(),
  site            text not null references public.sites(site) on delete cascade,
  multidev        text,
  status          text not null default 'running',   -- running | completed | failed
  reference_base  text,
  candidate_base  text,
  results         jsonb not null default '[]'::jsonb,
  flagged_count   integer not null default 0,
  started_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index if not exists vrt_runs_site_started_idx
  on public.vrt_runs (site, started_at desc);
