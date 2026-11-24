-- Immutable, evidence-backed transcript versions produced after an interview ends.
CREATE TABLE interview_transcript_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES interview_live_sessions(id) ON DELETE CASCADE,
  content_fingerprint text NOT NULL,
  turns jsonb NOT NULL CHECK (jsonb_typeof(turns) = 'array'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
  corrections jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(corrections) = 'array'),
  uncertainties jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(uncertainties) = 'array'),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, content_fingerprint)
);

CREATE INDEX interview_transcript_versions_session_created
  ON interview_transcript_versions(session_id, created_at DESC);

-- Published transcript versions are append-only. Deletion remains available only
-- through the parent interview cascade so existing retention workflows keep working.
CREATE FUNCTION prevent_interview_transcript_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'interview transcript versions are immutable';
END;
$$;
CREATE TRIGGER interview_transcript_versions_immutable
  BEFORE UPDATE ON interview_transcript_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_interview_transcript_version_update();

ALTER TABLE interview_live_sessions
  ADD COLUMN corrected_transcript_version_id uuid REFERENCES interview_transcript_versions(id) ON DELETE SET NULL;

CREATE TABLE interview_transcript_postprocess_jobs (
  session_id uuid PRIMARY KEY REFERENCES interview_live_sessions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed')),
  phase text NOT NULL DEFAULT 'offline_reidentification' CHECK (phase IN (
    'offline_reidentification','deduplication','role_review','context_correction','publishing')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim uuid,
  input_fingerprint text,
  error text,
  warnings jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings) = 'array'),
  available_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX interview_transcript_postprocess_queue
  ON interview_transcript_postprocess_jobs(available_at, updated_at)
  WHERE status <> 'completed';

-- Ending an interview queues post-processing before the summary can claim it.
CREATE FUNCTION queue_interview_transcript_postprocess_on_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    INSERT INTO interview_transcript_postprocess_jobs(session_id)
    VALUES (NEW.id)
    ON CONFLICT (session_id) DO UPDATE SET status='pending', phase='offline_reidentification',
      attempts=0, claim=NULL, input_fingerprint=NULL, error=NULL, available_at=now(), updated_at=now();

    UPDATE interview_live_sessions SET summary_status='pending', summary_revision=summary_revision+1,
      summary_claim=NULL, summary_report=NULL, summary_error=NULL, updated_at=now()
    WHERE id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER interview_transcript_postprocess_on_completion
  AFTER UPDATE OF status ON interview_live_sessions
  FOR EACH ROW EXECUTE FUNCTION queue_interview_transcript_postprocess_on_completion();

-- Consolidate the original summary invalidation and postprocess invalidation into
-- one trigger so one evidence change increments the summary revision only once.
-- Any late or human-edited evidence detaches the canonical version and queues a rerun.
CREATE OR REPLACE FUNCTION invalidate_interview_summary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.text,NEW.role,NEW.role_confidence,NEW.start_ms,NEW.end_ms,
      NEW.audio_source,NEW.audio_object_key,NEW.transcript_comparison)
      IS NOT DISTINCT FROM ROW(OLD.text,OLD.role,OLD.role_confidence,OLD.start_ms,OLD.end_ms,
      OLD.audio_source,OLD.audio_object_key,OLD.transcript_comparison) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN target_id := OLD.session_id; ELSE target_id := NEW.session_id; END IF;
  UPDATE interview_live_sessions SET corrected_transcript_version_id=NULL,
    summary_revision=summary_revision+1,
    summary_status=CASE WHEN status='completed' OR summary_status<>'none' THEN 'pending' ELSE 'none' END,
    summary_claim=NULL, summary_report=NULL, summary_error=NULL, updated_at=now()
    WHERE id=target_id;
  INSERT INTO interview_transcript_postprocess_jobs(session_id)
    SELECT target_id FROM interview_live_sessions WHERE id=target_id AND status='completed'
    ON CONFLICT (session_id) DO UPDATE SET status='pending', phase='offline_reidentification',
      attempts=0, claim=NULL, input_fingerprint=NULL, error=NULL, available_at=now(), updated_at=now();
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM interview_live_analyses WHERE segment_id=NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS interview_transcript_summary_invalidated ON interview_live_segments;
CREATE TRIGGER interview_transcript_summary_invalidated
  AFTER INSERT OR UPDATE OR DELETE ON interview_live_segments
  FOR EACH ROW EXECUTE FUNCTION invalidate_interview_summary();

-- Apply the pipeline to interviews completed before this migration as well.
INSERT INTO interview_transcript_postprocess_jobs(session_id)
SELECT id FROM interview_live_sessions WHERE status='completed'
ON CONFLICT (session_id) DO NOTHING;

UPDATE interview_live_sessions s SET summary_status='pending', summary_revision=summary_revision+1,
  summary_claim=NULL, summary_report=NULL, summary_error=NULL, updated_at=now()
WHERE s.status='completed' AND EXISTS (
  SELECT 1 FROM interview_transcript_postprocess_jobs j WHERE j.session_id=s.id AND j.status<>'completed')
  AND s.summary_status IN ('none','ready','failed','generating');

COMMENT ON TABLE interview_transcript_versions IS
  'Append-only corrected transcript versions; raw live segments remain unchanged as source evidence.';
COMMENT ON TABLE interview_transcript_postprocess_jobs IS
  'Automatic offline re-identification, deduplication, role review, terminology correction and publication queue.';
