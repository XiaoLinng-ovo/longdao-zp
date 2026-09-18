CREATE TABLE IF NOT EXISTS interview_live_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','failed')),
  external_status text NOT NULL DEFAULT 'not_configured',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_live_session_active ON interview_live_sessions(interview_id) WHERE status IN ('active','paused');
CREATE TABLE IF NOT EXISTS interview_live_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES interview_live_sessions(id) ON DELETE CASCADE,
  speaker_id text NOT NULL,
  role text NOT NULL DEFAULT 'unknown' CHECK (role IN ('interviewer','candidate','unknown')),
  role_confidence numeric(4,3) NOT NULL DEFAULT 0,
  text text NOT NULL,
  start_ms integer NOT NULL CHECK (start_ms >= 0),
  end_ms integer NOT NULL CHECK (end_ms >= start_ms),
  audio_object_key text,
  status text NOT NULL DEFAULT 'transcribed' CHECK (status IN ('transcribed','analyzing','analyzed','ignored','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS interview_live_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id uuid NOT NULL UNIQUE REFERENCES interview_live_segments(id) ON DELETE CASCADE,
  question text NOT NULL,
  summary text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]',
  scores jsonb NOT NULL DEFAULT '[]',
  concerns jsonb NOT NULL DEFAULT '[]',
  confidence numeric(4,3) NOT NULL,
  next_question text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_live_segments_session ON interview_live_segments(session_id, created_at);
