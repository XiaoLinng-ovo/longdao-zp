CREATE TABLE IF NOT EXISTS interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  interview_no text NOT NULL UNIQUE, round integer NOT NULL CHECK (round > 0), type text NOT NULL, title text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')), scheduled_start_at timestamptz,
  scheduled_end_at timestamptz, timezone text, location text, meeting_url text, participants jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS interview_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  interviewer_id uuid NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','locked')), overall_score numeric(5,2), recommendation text, ratings jsonb NOT NULL DEFAULT '{}', strengths jsonb NOT NULL DEFAULT '[]', concerns jsonb NOT NULL DEFAULT '[]', notes text, submitted_at timestamptz, locked_at timestamptz, UNIQUE (interview_id, interviewer_id)
);
CREATE INDEX IF NOT EXISTS idx_interviews_application ON interviews(application_id, round);
CREATE INDEX IF NOT EXISTS idx_interview_feedback_interview ON interview_feedback(interview_id, status);
