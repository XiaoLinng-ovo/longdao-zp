-- Durable resume import batches. Uploaded items remain after cancellation.

CREATE TABLE IF NOT EXISTS resume_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'uploading',
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resume_import_batches_status_check') THEN
    ALTER TABLE resume_import_batches ADD CONSTRAINT resume_import_batches_status_check
      CHECK (status IN ('uploading', 'completed', 'cancelled'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS resume_import_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES resume_import_batches(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  client_file_id text NOT NULL,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  status text NOT NULL DEFAULT 'pending_upload',
  candidate_id uuid REFERENCES candidates(id) ON DELETE SET NULL,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  resume_id uuid REFERENCES resumes(id) ON DELETE SET NULL,
  analysis_task_id uuid REFERENCES analysis_tasks(id) ON DELETE SET NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, ordinal),
  UNIQUE (batch_id, client_file_id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resume_import_items_status_check') THEN
    ALTER TABLE resume_import_items ADD CONSTRAINT resume_import_items_status_check
      CHECK (status IN ('pending_upload', 'uploading', 'queued', 'failed', 'cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS resume_import_batches_org_created_idx
  ON resume_import_batches(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS resume_import_batches_job_idx
  ON resume_import_batches(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS resume_import_items_batch_status_idx
  ON resume_import_items(batch_id, status, ordinal);
CREATE INDEX IF NOT EXISTS resume_import_items_org_updated_idx
  ON resume_import_items(organization_id, updated_at DESC);

DROP TRIGGER IF EXISTS resume_import_batches_set_updated_at ON resume_import_batches;
CREATE TRIGGER resume_import_batches_set_updated_at BEFORE UPDATE ON resume_import_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS resume_import_items_set_updated_at ON resume_import_items;
CREATE TRIGGER resume_import_items_set_updated_at BEFORE UPDATE ON resume_import_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
