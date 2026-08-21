-- 012 — Record WHICH files an upstream merge could not reconcile.
--
-- We never pass `--accept-upstream`: it would overwrite whatever the customer's
-- developers customised, with no way back short of a Pantheon snapshot. So a
-- conflict is not ours to resolve — it is information the customer needs, and
-- they can only act on it if we tell them exactly which files diverged.
--
-- `upstream_skipped_reason` already said "merge conflict"; this stores the paths
-- so the History tab and the Slack thread can hand over a concrete list.
alter table public.staging_history
  add column if not exists upstream_conflict_files text[];

comment on column public.staging_history.upstream_conflict_files is
  'Repo paths that conflicted while applying the Pantheon upstream (auto-reverted, nothing changed). Shared with the customer so their developers can decide how to proceed.';
