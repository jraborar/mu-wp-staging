-- Phase 4 (VRT) — per-site live URL used as the calibration/baseline source.
-- Pantheon custom domains vary and aren't derivable from the machine name
-- (e.g. apexorderpickup → https://www.apexorderpickup.com), so store it.
-- Idempotent: safe to run more than once.

alter table public.sites
  add column if not exists vrt_reference_base text;

comment on column public.sites.vrt_reference_base is
  'Live URL used as the VRT baseline / auto-tune (calibration) source, e.g. https://www.example.com';
