-- Run this in your Supabase SQL editor to add scheduling support

CREATE TABLE IF NOT EXISTS staging_schedules (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site                     text NOT NULL,
  site_name                text,
  cadence                  text NOT NULL CHECK (cadence IN ('weekly','biweekly','monthly','bimonthly-week-of-15','security-only')),
  -- Used by weekly, biweekly, and monthly (the target weekday: 0=Sun … 6=Sat)
  day_of_week              int  CHECK (day_of_week BETWEEN 0 AND 6),
  -- monthly only: which occurrence of day_of_week (1=first, 2=second, 3=third, 4=fourth, -1=last)
  week_of_month            int  CHECK (week_of_month IN (-1,1,2,3,4)),
  -- biweekly only: reference date to determine odd/even week parity
  biweekly_reference_date  date,
  -- bimonthly-week-of-15: first "on" month (1–12); on-months = (month - ref) % 2 === 0
  bimonthly_ref_month      int  CHECK (bimonthly_ref_month BETWEEN 1 AND 12),
  -- bimonthly-week-of-15: which weekday to run during the ISO week containing the 15th
  bimonthly_day_of_week    int  CHECK (bimonthly_day_of_week BETWEEN 0 AND 6),
  -- when true, this bimonthly site also triggers on new WordPress core releases
  security_check_enabled   boolean NOT NULL DEFAULT true,
  -- staging options
  skip_upstream            boolean NOT NULL DEFAULT false,
  skip_plugins_themes      boolean NOT NULL DEFAULT false,
  active                   boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  last_staged_at           timestamptz,
  next_staging_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_staging_schedules_next
  ON staging_schedules (next_staging_at)
  WHERE active = true;

-- Key-value store for scheduler state (e.g. last known WP version)
CREATE TABLE IF NOT EXISTS scheduler_state (
  key   text PRIMARY KEY,
  value text NOT NULL
);
