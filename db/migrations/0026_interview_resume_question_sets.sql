-- Resume-based question sets are stable across page visits and scoped to a single interview.
CREATE TABLE IF NOT EXISTS interview_resume_question_sets (
  interview_id uuid PRIMARY KEY REFERENCES interviews(id) ON DELETE CASCADE,
  generated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  engine text NOT NULL CHECK (engine IN ('llm', 'local_fallback')),
  questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(questions) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
