-- 009 — Cadence anchor. `last_deployment` = when the site's cycle last completed
-- (a mu_deploy deploy to any destination, or a multidev-only staging completion —
-- but NOT security/upstream fast-track runs). The staging cadence anchors its
-- ISO-week parity off this, so a newly-registered site with known history (e.g.
-- bowside last deployed the week of 2026-08-03) lands on the correct next week
-- instead of firing immediately or on an arbitrary parity.
alter table public.sites add column if not exists last_deployment timestamptz;
