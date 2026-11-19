-- Stopping capture and completing role review are distinct durable transitions.
DO $$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='r' AND c.relname='interview_live_sessions'
      AND (n.nspname='public' OR n.nspname IN (SELECT schema_name FROM public.organization_schemas))
  LOOP
    EXECUTE format('ALTER TABLE %I.interview_live_sessions ADD COLUMN manual_transcript_roles jsonb NOT NULL DEFAULT ''[]'' CHECK (jsonb_typeof(manual_transcript_roles)=''array'')', target.nspname);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION queue_interview_transcript_postprocess_on_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.ended_at IS NOT NULL AND OLD.ended_at IS NULL AND NEW.status='paused')
    OR (NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed'
      AND (NEW.corrected_transcript_version_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM interview_transcript_postprocess_jobs WHERE session_id=NEW.id AND status='completed'))) THEN
    INSERT INTO interview_transcript_postprocess_jobs(session_id) VALUES (NEW.id)
      ON CONFLICT (session_id) DO UPDATE SET status='pending',phase='offline_reidentification',
        attempts=0,claim=NULL,input_fingerprint=NULL,error=NULL,available_at=now(),updated_at=now();
    UPDATE interview_live_sessions SET summary_status='pending',summary_revision=summary_revision+1,
      summary_claim=NULL,summary_report=NULL,summary_error=NULL,updated_at=now() WHERE id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION invalidate_interview_summary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.text,NEW.role,NEW.role_confidence,NEW.start_ms,NEW.end_ms,
      NEW.audio_source,NEW.audio_object_key,NEW.transcript_comparison,NEW.speaker_confirmed,NEW.role_review)
      IS NOT DISTINCT FROM ROW(OLD.text,OLD.role,OLD.role_confidence,OLD.start_ms,OLD.end_ms,
      OLD.audio_source,OLD.audio_object_key,OLD.transcript_comparison,OLD.speaker_confirmed,OLD.role_review) THEN
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN target_id:=OLD.session_id; ELSE target_id:=NEW.session_id; END IF;
  UPDATE interview_live_sessions SET corrected_transcript_version_id=NULL,
    summary_revision=summary_revision+1,
    summary_status=CASE WHEN ended_at IS NOT NULL OR status='completed' OR summary_status<>'none' THEN 'pending' ELSE 'none' END,
    summary_claim=NULL,summary_report=NULL,summary_error=NULL,updated_at=now() WHERE id=target_id;
  INSERT INTO interview_transcript_postprocess_jobs(session_id)
    SELECT target_id FROM interview_live_sessions WHERE id=target_id AND (status='completed' OR status='paused' AND ended_at IS NOT NULL)
    ON CONFLICT (session_id) DO UPDATE SET status='pending',phase='offline_reidentification',
      attempts=0,claim=NULL,input_fingerprint=NULL,error=NULL,available_at=now(),updated_at=now();
  IF TG_OP='UPDATE' THEN DELETE FROM interview_live_analyses WHERE segment_id=NEW.id; END IF;
  RETURN NULL;
END;
$$;

-- A late manifest update must invalidate a review before another request can finish it.
CREATE FUNCTION invalidate_stopped_interview_audio() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session_row record;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.offset_ms,NEW.end_ms,NEW.audio_source,NEW.source_role,NEW.source_multiple_speakers)
    IS NOT DISTINCT FROM ROW(OLD.offset_ms,OLD.end_ms,OLD.audio_source,OLD.source_role,OLD.source_multiple_speakers) THEN RETURN NEW; END IF;
  SELECT * INTO session_row FROM interview_live_sessions WHERE id=NEW.session_id FOR UPDATE;
  IF session_row.status IN ('completed','failed') THEN RAISE EXCEPTION 'LIVE_SESSION_CLOSED'; END IF;
  IF session_row.ended_at IS NOT NULL THEN
    UPDATE interview_live_sessions SET corrected_transcript_version_id=NULL,summary_status='pending',
      summary_revision=summary_revision+1,summary_claim=NULL,summary_report=NULL,summary_error=NULL,updated_at=now() WHERE id=NEW.session_id;
    INSERT INTO interview_transcript_postprocess_jobs(session_id) VALUES (NEW.session_id)
      ON CONFLICT (session_id) DO UPDATE SET status='pending',phase='offline_reidentification',
        attempts=0,claim=NULL,input_fingerprint=NULL,error=NULL,available_at=now(),updated_at=now();
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='r' AND c.relname IN ('interview_live_sessions','interview_audio_recordings')
      AND (n.nspname='public' OR n.nspname IN (SELECT schema_name FROM public.organization_schemas))
  LOOP
    IF target.relname='interview_live_sessions' THEN
      EXECUTE format('DROP TRIGGER IF EXISTS interview_transcript_postprocess_on_completion ON %I.%I',target.nspname,target.relname);
      EXECUTE format('CREATE TRIGGER interview_transcript_postprocess_on_completion AFTER UPDATE OF status,ended_at ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.queue_interview_transcript_postprocess_on_completion()',target.nspname,target.relname);
    ELSE
      EXECUTE format('CREATE TRIGGER invalidate_stopped_interview_audio BEFORE INSERT OR UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.invalidate_stopped_interview_audio()',target.nspname,target.relname);
    END IF;
  END LOOP;
END;
$$;
