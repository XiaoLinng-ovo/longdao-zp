ALTER TABLE interview_live_segments
  ADD COLUMN IF NOT EXISTS transcript_comparison jsonb;
