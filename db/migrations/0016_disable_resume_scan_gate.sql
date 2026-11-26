-- Local development mode: resume uploads are immediately eligible for analysis.
-- Existing scan states were blocked only because the optional scanner was unavailable.
-- Remove the old monotonic scanner trigger before normalizing legacy rows; the
-- scanner is no longer an application workflow dependency.
DROP TRIGGER IF EXISTS resumes_scan_status_transition ON resumes;
DROP FUNCTION IF EXISTS enforce_resume_scan_status_transition();

UPDATE resumes
SET scan_status = 'clean'
WHERE scan_status IN ('quarantined', 'scanning', 'failed', 'local_unscanned');
