-- Complete recruitment request / job fields that the web form exposes but were
-- previously dropped on the repository path (employment type, work mode, location,
-- and the hiring-manager reference). These columns were missing from the schema,
-- so creating or editing a request/job silently lost the values.
ALTER TABLE recruitment_requests
  ADD COLUMN IF NOT EXISTS employment_type text,
  ADD COLUMN IF NOT EXISTS work_mode text,
  ADD COLUMN IF NOT EXISTS location text,
  ADD COLUMN IF NOT EXISTS hiring_manager_id uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS employment_type text,
  ADD COLUMN IF NOT EXISTS work_mode text,
  ADD COLUMN IF NOT EXISTS location text;
