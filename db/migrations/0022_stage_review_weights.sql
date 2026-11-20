-- 阶段权重：初试（人事面 / 用人部门面 / 录音）与复试（业务 / HR / BOSS / 录音）。
-- 页面按公式展示并允许面试官调整，因此权重存库、可重算、可审计。
ALTER TABLE interview_stage_reviews
  ADD COLUMN IF NOT EXISTS weights jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 权重调整留痕：谁、何时、原值 → 新值。
ALTER TABLE interview_stage_reviews
  ADD COLUMN IF NOT EXISTS weights_history jsonb NOT NULL DEFAULT '[]'::jsonb;
