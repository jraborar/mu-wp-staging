-- Phase 4 (VRT) — surface the shareable VRT report on each staging run.
-- After a Model-B run, the pipeline stores the report URL + flagged-path count
-- so the History tab can offer a one-click, customer-shareable link.
alter table public.staging_history add column if not exists vrt_report_url    text;
alter table public.staging_history add column if not exists vrt_flagged_count  integer;
alter table public.staging_history add column if not exists vrt_status         text;
