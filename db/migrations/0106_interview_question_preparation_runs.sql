-- Runtime retry identity is separate from the sealed legacy business snapshot.
-- No historical preparation or billing task is changed by this migration.
CREATE TABLE public.interview_question_preparation_runs (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  interview_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, interview_id)
);
