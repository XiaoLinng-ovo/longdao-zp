-- 可复用的岗位说明书 / JD 生成提示词 Skill。
CREATE TABLE IF NOT EXISTS ai_prompt_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  target_type text NOT NULL DEFAULT 'both' CHECK (target_type IN ('job_spec', 'jd', 'both')),
  content text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_prompt_skills_active_target
  ON ai_prompt_skills (is_active, target_type, updated_at DESC);
