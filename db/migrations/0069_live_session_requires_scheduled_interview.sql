-- A completed or cancelled interview is a historical record. Even if an older
-- client, a retry, or a direct database write bypasses the HTTP state check, it
-- must not be possible to add a new live interview session.
CREATE OR REPLACE FUNCTION enforce_live_session_scheduled_interview() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  interview_status text;
BEGIN
  SELECT status
    INTO interview_status
    FROM interviews
   WHERE id = NEW.interview_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTERVIEW_NOT_FOUND';
  END IF;

  IF interview_status = 'completed' THEN
    RAISE EXCEPTION 'INTERVIEW_ALREADY_COMPLETED';
  ELSIF interview_status = 'cancelled' THEN
    RAISE EXCEPTION 'INTERVIEW_CANCELLED';
  ELSIF interview_status <> 'scheduled' THEN
    RAISE EXCEPTION 'INTERVIEW_NOT_SCHEDULED';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS interview_live_sessions_require_scheduled ON interview_live_sessions;
CREATE TRIGGER interview_live_sessions_require_scheduled
  BEFORE INSERT ON interview_live_sessions
  FOR EACH ROW EXECUTE FUNCTION enforce_live_session_scheduled_interview();
