-- 面试问题表：一场面试（轮次）一张，记录该轮真实问答、三级答案方向与打分。
-- 数据来源复用实时面试已有的提问事件与转写片段，不新增采集。
CREATE TABLE IF NOT EXISTS interview_question_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'generating', 'scoring', 'submitted', 'locked')),
  source text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual')),
  generation_model text,
  prompt_version text,
  generation_error text,
  generated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  generated_at timestamptz,
  submitted_at timestamptz,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
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

CREATE INDEX IF NOT EXISTS idx_interview_questions_sheet ON interview_questions(sheet_id, seq);
CREATE INDEX IF NOT EXISTS idx_interview_question_sheets_status ON interview_question_sheets(status, updated_at);
