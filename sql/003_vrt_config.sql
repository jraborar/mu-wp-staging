-- Phase 4 (VRT) — per-site VRT configuration on the shared registry.
-- vrt_paths already exists (sql/001). This adds the enable flag + threshold.
-- Idempotent: safe to run more than once.

alter table public.sites
  add column if not exists vrt_enabled   boolean       not null default false,
  add column if not exists vrt_threshold numeric(6,3)  not null default 0.1;

comment on column public.sites.vrt_enabled   is 'Whether VRT runs for this site during managed updates.';
comment on column public.sites.vrt_threshold is 'Flag threshold as percent of pixels changed (0.1 = 0.1%). Per-site override of the global default.';

-- Keep the threshold sane (0%..100%). Add the constraint only if absent.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sites_vrt_threshold_range'
  ) then
    alter table public.sites
      add constraint sites_vrt_threshold_range
      check (vrt_threshold >= 0 and vrt_threshold <= 100);
  end if;
end $$;
