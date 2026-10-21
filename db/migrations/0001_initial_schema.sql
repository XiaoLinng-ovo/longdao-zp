-- SmartRecruit Pro initial domain schema
-- PostgreSQL 15+
-- This migration creates the Phase 1 foundation. Business commands are added in later phases.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text,
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recruitment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no text NOT NULL UNIQUE,
  title text NOT NULL,
  department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  headcount integer NOT NULL CHECK (headcount > 0),
  budget_min numeric(14, 2),
  budget_max numeric(14, 2),
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (budget_min IS NULL OR budget_max IS NULL OR budget_min <= budget_max)
);

CREATE TABLE IF NOT EXISTS approval_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  current_step integer NOT NULL DEFAULT 1 CHECK (current_step > 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS approval_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_instance_id uuid NOT NULL REFERENCES approval_instances(id) ON DELETE CASCADE,
  step_no integer NOT NULL CHECK (step_no > 0),
  approver_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  approver_role_code text,
  status text NOT NULL DEFAULT 'pending',
  UNIQUE (approval_instance_id, step_no)
);

CREATE TABLE IF NOT EXISTS approval_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_instance_id uuid NOT NULL REFERENCES approval_instances(id) ON DELETE CASCADE,
  approval_step_id uuid REFERENCES approval_steps(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  decision text NOT NULL,
  comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_no text NOT NULL UNIQUE,
  recruitment_request_id uuid REFERENCES recruitment_requests(id) ON DELETE SET NULL,
  department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  headcount integer NOT NULL CHECK (headcount > 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_spec_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, version)
);

CREATE TABLE IF NOT EXISTS job_description_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  content text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, version)
);

CREATE TABLE IF NOT EXISTS candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_no text NOT NULL UNIQUE,
  name text NOT NULL,
  email text,
  phone text,
  location text,
  source text,
  consent_status text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_no text NOT NULL UNIQUE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'new',
  recruiter_id uuid REFERENCES users(id) ON DELETE SET NULL,
  source text,
  applied_at timestamptz NOT NULL DEFAULT now(),
  rejected_reason text,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, job_id)
);

CREATE TABLE IF NOT EXISTS resumes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE RESTRICT,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  storage_key text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  scan_status text NOT NULL DEFAULT 'quarantined',
  parser_version text,
  content_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analysis_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resume_id uuid NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  idempotency_key text NOT NULL UNIQUE,
  last_error text,
  available_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analysis_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_task_id uuid NOT NULL UNIQUE REFERENCES analysis_tasks(id) ON DELETE CASCADE,
  resume_id uuid NOT NULL REFERENCES resumes(id) ON DELETE RESTRICT,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_provider text,
  model_name text,
  prompt_version text,
  analyzer_version text,
  input_hash text,
  human_review_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  request_id text,
  ip_address inet,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recruitment_requests_status ON recruitment_requests(status);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_applications_candidate ON applications(candidate_id);
CREATE INDEX IF NOT EXISTS idx_applications_job_status ON applications(job_id, status);
CREATE INDEX IF NOT EXISTS idx_resumes_candidate ON resumes(candidate_id);
CREATE INDEX IF NOT EXISTS idx_analysis_tasks_status_available ON analysis_tasks(status, available_at);
CREATE INDEX IF NOT EXISTS idx_workflow_events_subject ON workflow_events(subject_type, subject_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_events_pending ON outbox_events(status, available_at);

DROP TRIGGER IF EXISTS departments_set_updated_at ON departments;
CREATE TRIGGER departments_set_updated_at BEFORE UPDATE ON departments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS recruitment_requests_set_updated_at ON recruitment_requests;
CREATE TRIGGER recruitment_requests_set_updated_at BEFORE UPDATE ON recruitment_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS jobs_set_updated_at ON jobs;
CREATE TRIGGER jobs_set_updated_at BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS candidates_set_updated_at ON candidates;
CREATE TRIGGER candidates_set_updated_at BEFORE UPDATE ON candidates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS applications_set_updated_at ON applications;
CREATE TRIGGER applications_set_updated_at BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
