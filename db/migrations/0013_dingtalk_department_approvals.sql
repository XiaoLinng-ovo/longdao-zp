CREATE TABLE IF NOT EXISTS department_approval_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  subject_type text NOT NULL DEFAULT 'recruitment_request',
  process_code text NOT NULL,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, subject_type)
);

ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS external_instance_id text;
ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS external_step_id text;
ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS node_name text;

CREATE UNIQUE INDEX IF NOT EXISTS approval_instances_provider_external_idx
  ON approval_instances(provider, external_instance_id)
  WHERE provider IS NOT NULL AND external_instance_id IS NOT NULL;
