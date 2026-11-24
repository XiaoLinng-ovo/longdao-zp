-- Complete the onboarding coordination workbench. This migration is additive
-- and keeps historic pending records readable.

ALTER TABLE onboarding_records
  ADD COLUMN IF NOT EXISTS work_city text,
  ADD COLUMN IF NOT EXISTS office_location text,
  ADD COLUMN IF NOT EXISTS cancellation_reason_code text,
  ADD COLUMN IF NOT EXISTS cancellation_notes text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS no_show_reason_code text,
  ADD COLUMN IF NOT EXISTS no_show_notes text,
  ADD COLUMN IF NOT EXISTS no_show_at timestamptz,
  ADD COLUMN IF NOT EXISTS actual_arrival_at timestamptz;

ALTER TABLE onboarding_records
  DROP CONSTRAINT IF EXISTS onboarding_records_status_check;
ALTER TABLE onboarding_records
  ADD CONSTRAINT onboarding_records_status_check
  CHECK (status IN ('pending', 'preparing', 'scheduled', 'completed', 'no_show', 'cancelled'));

ALTER TABLE onboarding_records
  DROP CONSTRAINT IF EXISTS onboarding_records_cancellation_reason_check;
ALTER TABLE onboarding_records
  ADD CONSTRAINT onboarding_records_cancellation_reason_check
  CHECK (cancellation_reason_code IS NULL OR cancellation_reason_code IN (
    'candidate_declined', 'offer_revoked', 'schedule_changed', 'position_closed',
    'failed_requirements', 'other'
  ));

ALTER TABLE onboarding_records
  DROP CONSTRAINT IF EXISTS onboarding_records_no_show_reason_check;
ALTER TABLE onboarding_records
  ADD CONSTRAINT onboarding_records_no_show_reason_check
  CHECK (no_show_reason_code IS NULL OR no_show_reason_code IN (
    'candidate_unreachable', 'personal_reason', 'another_offer',
    'document_issue', 'attendance_issue', 'other'
  ));

ALTER TABLE onboarding_tasks
  ADD COLUMN IF NOT EXISTS is_required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS owner_role text,
  ADD COLUMN IF NOT EXISTS template_key text;

ALTER TABLE onboarding_tasks
  DROP CONSTRAINT IF EXISTS onboarding_tasks_category_check;
ALTER TABLE onboarding_tasks
  ADD CONSTRAINT onboarding_tasks_category_check
  CHECK (category IN ('hr', 'it', 'admin', 'manager', 'training', 'candidate'));

ALTER TABLE onboarding_tasks
  DROP CONSTRAINT IF EXISTS onboarding_tasks_owner_role_check;
ALTER TABLE onboarding_tasks
  ADD CONSTRAINT onboarding_tasks_owner_role_check
  CHECK (owner_role IS NULL OR owner_role IN ('recruiter', 'hiring_manager', 'admin', 'hr_admin', 'candidate'));

CREATE UNIQUE INDEX IF NOT EXISTS onboarding_tasks_template_idx
  ON onboarding_tasks (onboarding_id, template_key)
  WHERE template_key IS NOT NULL;

UPDATE onboarding_tasks
SET template_key = CASE title
  WHEN '确认入职材料与合同准备' THEN 'hr_documents'
  WHEN '准备账号与基础权限' THEN 'it_accounts'
  WHEN '准备办公设备与工位' THEN 'admin_workplace'
  WHEN '确认直属主管与首周安排' THEN 'manager_first_week'
  WHEN '安排新员工入职培训' THEN 'training_orientation'
  ELSE template_key
END,
owner_role = CASE category
  WHEN 'manager' THEN 'hiring_manager'
  WHEN 'it' THEN 'admin'
  WHEN 'admin' THEN 'admin'
  ELSE 'hr_admin'
END
WHERE template_key IS NULL AND title IN (
  '确认入职材料与合同准备', '准备账号与基础权限', '准备办公设备与工位',
  '确认直属主管与首周安排', '安排新员工入职培训'
);

CREATE TABLE IF NOT EXISTS onboarding_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  onboarding_id uuid NOT NULL REFERENCES onboarding_records(id) ON DELETE CASCADE,
  code text NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  is_required boolean NOT NULL DEFAULT true,
  collected_at timestamptz,
  verified_at timestamptz,
  verified_by_user_id uuid,
  waived_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (onboarding_id, code),
  CHECK (char_length(code) BETWEEN 1 AND 100),
  CHECK (char_length(label) BETWEEN 1 AND 200),
  CHECK (status IN ('pending', 'collected', 'verified', 'waived'))
);

CREATE INDEX IF NOT EXISTS onboarding_materials_org_status_idx
  ON onboarding_materials (organization_id, status, is_required);

CREATE TABLE IF NOT EXISTS onboarding_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  onboarding_id uuid NOT NULL REFERENCES onboarding_records(id) ON DELETE CASCADE,
  milestone text NOT NULL,
  audience text NOT NULL,
  channel text NOT NULL DEFAULT 'in_app',
  status text NOT NULL DEFAULT 'scheduled',
  scheduled_at timestamptz NOT NULL,
  sent_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (onboarding_id, milestone, audience, channel),
  CHECK (milestone IN ('7_days', '3_days', 'day_of')),
  CHECK (audience IN ('candidate', 'hr', 'manager', 'it', 'admin')),
  CHECK (channel IN ('in_app', 'email')),
  CHECK (status IN ('scheduled', 'sent', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS onboarding_reminders_due_idx
  ON onboarding_reminders (organization_id, status, scheduled_at);

CREATE TABLE IF NOT EXISTS onboarding_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  onboarding_id uuid NOT NULL REFERENCES onboarding_records(id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'not_configured',
  external_reference text,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (onboarding_id, provider),
  CHECK (provider IN ('oa', 'it_service_desk', 'access_control', 'email_account', 'hris')),
  CHECK (status IN ('not_configured', 'pending', 'syncing', 'ready', 'failed'))
);

CREATE INDEX IF NOT EXISTS onboarding_integrations_org_status_idx
  ON onboarding_integrations (organization_id, provider, status);

WITH checklist (category, title, owner_name, owner_role, template_key, is_required) AS (
  VALUES
    ('hr', '核对劳动合同与入职材料', 'HR', 'hr_admin', 'hr_documents', true),
    ('hr', '建立员工档案并录入 HRIS', 'HR', 'hr_admin', 'hr_employee_record', true),
    ('it', '开通账号与工作邮箱', 'IT', 'admin', 'it_accounts', true),
    ('it', '配置系统权限与 VPN', 'IT', 'admin', 'it_permissions', true),
    ('admin', '准备工位、电脑与办公用品', '行政', 'admin', 'admin_workplace', true),
    ('admin', '办理门禁卡与园区权限', '行政', 'admin', 'admin_access_card', true),
    ('manager', '确认直属主管与报到联系人', '用人部门', 'hiring_manager', 'manager_first_week', true),
    ('manager', '制定首周计划与岗位目标', '用人部门', 'hiring_manager', 'manager_goals', true),
    ('training', '安排入职引导与团队介绍', '培训负责人', 'hr_admin', 'training_orientation', true),
    ('training', '完成合规与信息安全培训', '培训负责人', 'hr_admin', 'training_compliance', true),
    ('candidate', '确认报到时间、地点与交通方式', '候选人', 'candidate', 'candidate_reporting_confirmation', true),
    ('candidate', '提交并核对入职材料', '候选人', 'candidate', 'candidate_materials', true)
)
INSERT INTO onboarding_tasks (
  organization_id, onboarding_id, title, category, owner_name, owner_role,
  template_key, is_required, status
)
SELECT r.organization_id, r.id, c.title, c.category, c.owner_name, c.owner_role,
       c.template_key, c.is_required, 'pending'
FROM onboarding_records r
CROSS JOIN checklist c
WHERE NOT EXISTS (
  SELECT 1 FROM onboarding_tasks t
  WHERE t.onboarding_id = r.id AND t.template_key = c.template_key
);

INSERT INTO onboarding_materials (
  organization_id, onboarding_id, code, label, is_required
)
SELECT DISTINCT r.organization_id, r.id, material.code, material.code, true
FROM onboarding_records r
JOIN offers o ON o.id = r.offer_id
JOIN offer_versions v ON v.id = COALESCE(
  o.current_version_id,
  (SELECT latest.id FROM offer_versions latest WHERE latest.offer_id = o.id ORDER BY latest.version DESC LIMIT 1)
)
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(v.materials) = 'array' THEN v.materials ELSE '[]'::jsonb END
) AS material(code)
WHERE material.code <> ''
ON CONFLICT (onboarding_id, code) DO NOTHING;

WITH providers (provider) AS (
  VALUES ('oa'), ('it_service_desk'), ('access_control'), ('email_account'), ('hris')
)
INSERT INTO onboarding_integrations (organization_id, onboarding_id, provider)
SELECT r.organization_id, r.id, p.provider
FROM onboarding_records r
CROSS JOIN providers p
ON CONFLICT (onboarding_id, provider) DO NOTHING;

WITH milestones (milestone, day_offset) AS (
  VALUES ('7_days', 7), ('3_days', 3), ('day_of', 0)
), audiences (audience) AS (
  VALUES ('candidate'), ('hr'), ('manager'), ('it'), ('admin')
)
INSERT INTO onboarding_reminders (
  organization_id, onboarding_id, milestone, audience, channel, scheduled_at
)
SELECT r.organization_id, r.id, m.milestone, a.audience, 'in_app',
       ((r.planned_start_date - m.day_offset)::timestamp + time '09:00') AT TIME ZONE 'Asia/Shanghai'
FROM onboarding_records r
CROSS JOIN milestones m
CROSS JOIN audiences a
WHERE r.planned_start_date IS NOT NULL
  AND r.status IN ('scheduled', 'completed', 'no_show')
ON CONFLICT (onboarding_id, milestone, audience, channel) DO NOTHING;

DROP TRIGGER IF EXISTS onboarding_materials_set_updated_at ON onboarding_materials;
CREATE TRIGGER onboarding_materials_set_updated_at
  BEFORE UPDATE ON onboarding_materials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS onboarding_reminders_set_updated_at ON onboarding_reminders;
CREATE TRIGGER onboarding_reminders_set_updated_at
  BEFORE UPDATE ON onboarding_reminders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS onboarding_integrations_set_updated_at ON onboarding_integrations;
CREATE TRIGGER onboarding_integrations_set_updated_at
  BEFORE UPDATE ON onboarding_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
