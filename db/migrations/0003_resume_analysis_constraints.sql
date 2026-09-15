-- Resume upload and analysis task constraints for the first business implementation.
-- The local adapter mirrors these states until PostgreSQL is available.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resumes_scan_status_check') THEN
    ALTER TABLE resumes ADD CONSTRAINT resumes_scan_status_check
      CHECK (scan_status IN ('quarantined', 'scanning', 'clean', 'infected', 'failed', 'local_unscanned'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analysis_tasks_status_check') THEN
    ALTER TABLE analysis_tasks ADD CONSTRAINT analysis_tasks_status_check
      CHECK (status IN ('queued', 'processing', 'completed', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analysis_results_human_review_status_check') THEN
    ALTER TABLE analysis_results ADD CONSTRAINT analysis_results_human_review_status_check
      CHECK (human_review_status IN ('pending', 'accepted', 'needs_correction', 'not_required'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_resumes_application_created
  ON resumes(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_tasks_resume_created
  ON analysis_tasks(resume_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_results_application_created
  ON analysis_results(application_id, created_at DESC);
