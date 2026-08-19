-- Phase 4 (VRT) — per-path VRT config.
-- Replaces the single site-level threshold with one row per path, each with
-- its own threshold + excluded elements. vrt_targets is the source of truth;
-- vrt_paths is mirrored from it (kept for staging/badges compatibility).
-- vrt_threshold stays as the per-site DEFAULT applied to newly-added paths.
-- Idempotent: safe to run more than once.

alter table public.sites
  add column if not exists vrt_targets jsonb not null default '[]'::jsonb;

comment on column public.sites.vrt_targets is
  'Per-path VRT config: [{"path","label","threshold","exclude":[...]}]. Source of truth; vrt_paths mirrors the paths.';

-- Backfill: seed vrt_targets from any existing vrt_paths, using the site''s
-- current vrt_threshold as each row''s starting threshold. Only for rows that
-- have paths but no targets yet.
update public.sites s
set vrt_targets = (
  select coalesce(jsonb_agg(
    jsonb_build_object('path', p, 'label', '', 'threshold', s.vrt_threshold, 'exclude', '[]'::jsonb)
  ), '[]'::jsonb)
  from unnest(s.vrt_paths) as p
)
where coalesce(jsonb_array_length(s.vrt_targets), 0) = 0
  and coalesce(array_length(s.vrt_paths, 1), 0) > 0;
