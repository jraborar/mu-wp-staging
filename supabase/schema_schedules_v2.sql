-- Migration: add deploy_days column to staging_schedules
-- Run this in your Supabase SQL editor

ALTER TABLE staging_schedules
  ADD COLUMN IF NOT EXISTS deploy_days int;
