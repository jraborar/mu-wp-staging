-- sql/019: add security_fast_track to staging_schedules
--
-- One-off schedules and runNow can now carry the security fast-track flag so
-- plugin/theme CVE patches get the 24h deploy window without advancing the
-- site's staging cadence anchor.

alter table staging_schedules
  add column if not exists security_fast_track boolean not null default false;
