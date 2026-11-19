ALTER TABLE interview_live_sessions
  ADD COLUMN IF NOT EXISTS current_question text NOT NULL DEFAULT '请先做一下自我介绍，并重点说明与你应聘岗位相关的经历。';

CREATE TABLE IF NOT EXISTS interview_live_question_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES interview_live_sessions(id) ON DELETE CASCADE,
  question text NOT NULL,
  source text NOT NULL CHECK (source IN ('manual', 'ai_adopted')),
  actor_id uuid NOT NULL,
  segment_id uuid REFERENCES interview_live_segments(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_live_question_events_session ON interview_live_question_events(session_id, created_at);
