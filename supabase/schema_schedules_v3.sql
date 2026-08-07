-- Migration: add security_check_pending column to staging_schedules
-- Run this in your Supabase SQL editor

ALTER TABLE staging_schedules
  ADD COLUMN IF NOT EXISTS security_check_pending boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_staging_schedules_pending
  ON staging_schedules (security_check_pending)
  WHERE active = true AND security_check_pending = true;
