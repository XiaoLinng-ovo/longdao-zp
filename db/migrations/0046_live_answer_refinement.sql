ALTER TABLE interview_live_analyses
  ADD COLUMN transcript_refinement jsonb,
  ADD COLUMN source_segments jsonb;
