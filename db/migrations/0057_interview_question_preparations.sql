-- Durable, interview-scoped preparation. Partial results survive retries/restarts.
CREATE TABLE interview_question_preparations (
  interview_id uuid PRIMARY KEY REFERENCES interviews(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','generating','ready','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  claim_token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  input_hash text,
  completed_groups jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interview_question_preparations_pending
  ON interview_question_preparations (available_at, created_at)
  WHERE status IN ('queued','generating');
