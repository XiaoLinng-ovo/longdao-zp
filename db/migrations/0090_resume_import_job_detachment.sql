-- Keep import history after explicitly releasing its job deletion constraint.
ALTER TABLE resume_import_batches
  ALTER COLUMN job_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS detached_job_id uuid,
  ADD COLUMN IF NOT EXISTS detached_job_title text,
  ADD COLUMN IF NOT EXISTS detached_at timestamptz;
