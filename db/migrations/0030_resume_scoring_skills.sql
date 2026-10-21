-- 岗位文档 Skill 与简历评分 Skill 独立；both 仍仅表示岗位说明书和 JD。
ALTER TABLE ai_prompt_skills DROP CONSTRAINT IF EXISTS ai_prompt_skills_target_type_check;
ALTER TABLE ai_prompt_skills ADD CONSTRAINT ai_prompt_skills_target_type_check
  CHECK (target_type IN ('job_spec', 'jd', 'both', 'resume_score'));

-- 一个评分 Skill 可以复用到多个岗位；一个岗位只能绑定一套明确的评分规则。
CREATE TABLE IF NOT EXISTS ai_resume_scoring_skill_jobs (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES ai_prompt_skills(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_resume_scoring_skill_jobs_skill
  ON ai_resume_scoring_skill_jobs (skill_id);
