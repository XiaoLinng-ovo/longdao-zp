-- Normalized recruitment-request approval workflow metadata.
ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS acted_at timestamptz;

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY subject_type, subject_id ORDER BY created_at, id) AS version
  FROM approval_instances
)
UPDATE approval_instances ai
SET version = ranked.version
FROM ranked
WHERE ai.id = ranked.id;

CREATE INDEX IF NOT EXISTS idx_approval_instances_subject_version
  ON approval_instances(subject_type, subject_id, version DESC, created_at DESC);
