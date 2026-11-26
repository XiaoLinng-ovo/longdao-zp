CREATE TABLE IF NOT EXISTS organization_trial_ai_usage (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  generations integer NOT NULL DEFAULT 0 CHECK (generations >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_usage_tasks
  ADD COLUMN IF NOT EXISTS trial_quota_charged boolean NOT NULL DEFAULT false;

-- Carry over successful AI generations for existing trial organizations.
INSERT INTO organization_trial_ai_usage (organization_id, generations)
SELECT o.id,
       (SELECT count(*)::integer
          FROM ai_usage_tasks t
         WHERE t.organization_id = o.id
           AND t.operation IN ('job_spec', 'jd')
           AND t.state = 'settled')
FROM organizations o
WHERE o.service_status = 'trial'
ON CONFLICT (organization_id) DO NOTHING;
