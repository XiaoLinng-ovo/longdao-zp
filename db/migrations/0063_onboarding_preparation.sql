ALTER TABLE onboarding_records
  ADD COLUMN IF NOT EXISTS planned_start_time time,
  ADD COLUMN IF NOT EXISTS reporting_mode text,
  ADD COLUMN IF NOT EXISTS reporting_location text,
  ADD COLUMN IF NOT EXISTS reporting_contact_name text,
  ADD COLUMN IF NOT EXISTS reporting_contact_phone text,
  ADD COLUMN IF NOT EXISTS hr_owner_name text,
  ADD COLUMN IF NOT EXISTS hiring_manager_name text,
  ADD COLUMN IF NOT EXISTS risk_notes text;

ALTER TABLE onboarding_records
  DROP CONSTRAINT IF EXISTS onboarding_records_reporting_mode_check;
ALTER TABLE onboarding_records
  ADD CONSTRAINT onboarding_records_reporting_mode_check
  CHECK (reporting_mode IS NULL OR reporting_mode IN ('onsite', 'remote', 'hybrid'));

CREATE TABLE IF NOT EXISTS onboarding_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  onboarding_id uuid NOT NULL REFERENCES onboarding_records(id) ON DELETE CASCADE,
  title text NOT NULL,
  category text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  owner_name text,
  due_date date,
  notes text,
  blocked_reason text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(title) BETWEEN 1 AND 200),
  CHECK (category IN ('hr', 'it', 'admin', 'manager', 'training')),
  CHECK (status IN ('pending', 'in_progress', 'completed', 'blocked', 'not_required'))
);

CREATE INDEX IF NOT EXISTS onboarding_tasks_onboarding_idx ON onboarding_tasks (onboarding_id, category, created_at);
CREATE INDEX IF NOT EXISTS onboarding_tasks_organization_status_idx ON onboarding_tasks (organization_id, status, due_date);

-- Existing archived offers predate the preparation checklist. Seed only the
-- missing defaults so those records can enter the new coordination workflow.
WITH default_tasks (category, title, owner_name) AS (
  VALUES
    ('hr', '确认入职材料与合同准备', 'HR'),
    ('it', '准备账号与基础权限', 'IT'),
    ('admin', '准备办公设备与工位', '行政'),
    ('manager', '确认直属主管与首周安排', '用人部门'),
    ('training', '安排新员工入职培训', '培训负责人')
)
INSERT INTO onboarding_tasks (organization_id, onboarding_id, title, category, owner_name)
SELECT r.organization_id, r.id, d.title, d.category, d.owner_name
FROM onboarding_records r
CROSS JOIN default_tasks d
WHERE NOT EXISTS (
  SELECT 1
  FROM onboarding_tasks t
  WHERE t.onboarding_id = r.id AND t.category = d.category AND t.title = d.title
);

DROP TRIGGER IF EXISTS onboarding_tasks_set_updated_at ON onboarding_tasks;
CREATE TRIGGER onboarding_tasks_set_updated_at
  BEFORE UPDATE ON onboarding_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
