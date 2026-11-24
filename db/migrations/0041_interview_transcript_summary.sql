ALTER TABLE interview_live_sessions
  ADD COLUMN summary_status text NOT NULL DEFAULT 'none' CHECK (summary_status IN ('none','pending','generating','ready','failed')),
  ADD COLUMN summary_report jsonb,
  ADD COLUMN summary_error text,
  ADD COLUMN summary_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN summary_claim uuid,
  ADD COLUMN summary_requested_by uuid REFERENCES users(id);

CREATE INDEX interview_summary_queue_idx ON interview_live_sessions(summary_status, updated_at)
  WHERE summary_status IN ('pending','generating');

-- Late audio and human corrections invalidate both the report and any in-flight claim.
CREATE FUNCTION invalidate_interview_summary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.text,NEW.role,NEW.role_confidence,NEW.start_ms,NEW.end_ms)
      IS NOT DISTINCT FROM ROW(OLD.text,OLD.role,OLD.role_confidence,OLD.start_ms,OLD.end_ms) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN target_id := OLD.session_id; ELSE target_id := NEW.session_id; END IF;
  UPDATE interview_live_sessions SET summary_revision=summary_revision+1,
    summary_status=CASE WHEN status='completed' OR summary_status<>'none' THEN 'pending' ELSE 'none' END,
    summary_claim=NULL, summary_report=NULL, summary_error=NULL, updated_at=now()
    WHERE id=target_id;
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM interview_live_analyses WHERE segment_id=NEW.id;
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER interview_transcript_summary_invalidated
  AFTER INSERT OR UPDATE OR DELETE ON interview_live_segments
  FOR EACH ROW EXECUTE FUNCTION invalidate_interview_summary();
