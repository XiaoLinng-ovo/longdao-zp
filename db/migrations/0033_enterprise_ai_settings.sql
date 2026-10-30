-- No global credential or historical Skill is copied to a customer organization.
CREATE TABLE enterprise_ai_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  base_url text NOT NULL DEFAULT '',
  api_key_ciphertext text,
  model text NOT NULL DEFAULT '',
  timeout_ms integer NOT NULL DEFAULT 120000 CHECK (timeout_ms BETWEEN 1 AND 300000),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- NULL means an unassigned historical/global Skill. It stays retained, but tenant APIs cannot see or use it.
ALTER TABLE ai_prompt_skills ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT;
CREATE INDEX ai_prompt_skills_organization_target_idx ON ai_prompt_skills (organization_id, is_active, target_type, updated_at DESC);
