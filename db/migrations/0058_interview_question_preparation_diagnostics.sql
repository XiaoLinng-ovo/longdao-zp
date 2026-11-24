ALTER TABLE interview_question_preparations
  ADD COLUMN failure_stage text,
  ADD COLUMN failure_group text,
  ADD COLUMN failure_code text,
  ADD COLUMN failure_details jsonb,
  ADD COLUMN rubrics_status text CHECK (rubrics_status IN ('queued', 'ready'));
