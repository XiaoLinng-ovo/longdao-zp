-- 0020 的初版把面试表挂在"一场面试"上；实际流程是初试（人事面 + 用人部门面）与复试（业务 + HR + BOSS）。
-- 0020 建的两张表当时没有数据，这里直接重建为"应聘 + 阶段 + 表类型"，并补上阶段汇总表。
DROP TABLE IF EXISTS interview_questions;
DROP TABLE IF EXISTS interview_question_sheets;

-- 面试阶段：默认按轮次推断（第 1 轮=初试，第 2 轮及以后=复试），后续可在面试里显式调整。
ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'initial' CHECK (stage IN ('initial', 'final'));

UPDATE interviews SET stage = 'final' WHERE round >= 2 AND stage <> 'final';

CREATE TABLE IF NOT EXISTS interview_question_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('initial', 'final')),
  sheet_type text NOT NULL CHECK (sheet_type IN ('hr_screen', 'hiring_department', 'business', 'hr', 'boss')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'generating', 'scoring', 'submitted', 'locked')),
  source text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual')),
  generation_model text,
  prompt_version text,
  generation_error text,
  generation_notice text,
  generated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  generated_at timestamptz,
  submitted_at timestamptz,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, stage, sheet_type)
);

CREATE TABLE IF NOT EXISTS interview_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id uuid NOT NULL REFERENCES interview_question_sheets(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq > 0),
  question text NOT NULL,
  dimension text,
  category text,
  difficulty text,
  source text NOT NULL CHECK (source IN ('live_question', 'ai_generated', 'manual')),
  question_event_id uuid REFERENCES interview_live_question_events(id) ON DELETE SET NULL,
  answer_segment_ids uuid[] NOT NULL DEFAULT '{}',
  answer_text text,
  tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_tier text,
  ai_score integer CHECK (ai_score IS NULL OR (ai_score BETWEEN 0 AND 100)),
  ai_rationale text,
  ai_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  final_tier text,
  final_score integer CHECK (final_score IS NULL OR (final_score BETWEEN 0 AND 100)),
  comment text,
  scored_by uuid REFERENCES users(id) ON DELETE SET NULL,
  scored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sheet_id, seq)
);

-- 阶段汇总：初试总分与是否进复试，复试的 AI 录取建议。AI 只给建议，决定由人落。
CREATE TABLE IF NOT EXISTS interview_stage_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('initial', 'final')),
  sheet_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  recording_score integer CHECK (recording_score IS NULL OR (recording_score BETWEEN 0 AND 100)),
  ai_score integer CHECK (ai_score IS NULL OR (ai_score BETWEEN 0 AND 100)),
  ai_recommendation text CHECK (ai_recommendation IS NULL OR (ai_recommendation IN ('strong_yes', 'yes', 'mixed', 'no'))),
  ai_rationale text,
  ai_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision text CHECK (decision IS NULL OR (decision IN ('advanced', 'rejected', 'hired', 'hold'))),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_interview_questions_sheet ON interview_questions(sheet_id, seq);
CREATE INDEX IF NOT EXISTS idx_interview_question_sheets_status ON interview_question_sheets(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_interview_question_sheets_application ON interview_question_sheets(application_id, stage);
