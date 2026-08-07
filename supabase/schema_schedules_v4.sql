-- Migration: add deploy_destination column to staging_schedules
-- Run this in your Supabase SQL editor

ALTER TABLE staging_schedules
  ADD COLUMN IF NOT EXISTS deploy_destination text;
