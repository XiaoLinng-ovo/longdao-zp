-- Enforce the resume malware-scan lifecycle at the PostgreSQL boundary.
-- Application code may provide the same guard, but direct SQL and competing
-- workers must not be able to reopen a terminal scan result.

CREATE OR REPLACE FUNCTION enforce_resume_scan_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scan_status = OLD.scan_status THEN
    RETURN NEW;
  END IF;

  IF OLD.scan_status = 'quarantined'
     AND NEW.scan_status IN ('scanning', 'clean', 'infected', 'failed', 'local_unscanned') THEN
    RETURN NEW;
  END IF;

  IF OLD.scan_status = 'scanning'
     AND NEW.scan_status IN ('clean', 'infected', 'failed') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid resume scan status transition: % -> %', OLD.scan_status, NEW.scan_status
    USING ERRCODE = '22000';
END;
$$;

DROP TRIGGER IF EXISTS resumes_scan_status_transition ON resumes;
CREATE TRIGGER resumes_scan_status_transition
  BEFORE UPDATE OF scan_status ON resumes
  FOR EACH ROW
  EXECUTE FUNCTION enforce_resume_scan_status_transition();

