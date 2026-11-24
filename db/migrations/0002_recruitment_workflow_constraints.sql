-- Recruitment workflow constraints and transaction-supporting indexes.
-- This migration is additive. State changes are still performed by application
-- commands inside one PostgreSQL transaction with SELECT ... FOR UPDATE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recruitment_requests_status_check') THEN
    ALTER TABLE recruitment_requests ADD CONSTRAINT recruitment_requests_status_check
      CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'withdrawn', 'converted', 'closed', 'cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_status_check') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
      CHECK (status IN ('draft', 'ready', 'published', 'paused', 'closed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_instances_status_check') THEN
    ALTER TABLE approval_instances ADD CONSTRAINT approval_instances_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'));
  END IF;
END $$;

ALTER TABLE job_spec_versions ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE job_spec_versions ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE job_description_versions ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE job_description_versions ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_recruitment_requests_department_status
  ON recruitment_requests(department_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_request_status
  ON jobs(recruitment_request_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_instances_subject_created
  ON approval_instances(subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_events_subject_created
  ON workflow_events(subject_type, subject_id, created_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  route text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, route, idempotency_key)
);
