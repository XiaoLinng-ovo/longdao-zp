-- Speaker uncertainty is advisory; retain reports while corrected evidence is rescored.
CREATE OR REPLACE FUNCTION preserve_interview_summary_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.summary_report IS NOT NULL AND NOT OLD.summary_stale AND (NEW.summary_report IS DISTINCT FROM OLD.summary_report OR NEW.summary_revision<>OLD.summary_revision) THEN
    INSERT INTO interview_summary_versions(session_id,organization_id,revision,transcript_version_id,report)
      VALUES(OLD.id,OLD.organization_id,OLD.summary_revision,OLD.corrected_transcript_version_id,OLD.summary_report)
      ON CONFLICT DO NOTHING;
  END IF;
  IF OLD.summary_report IS NOT NULL AND NEW.summary_report IS NULL THEN NEW.summary_report:=OLD.summary_report; END IF;
  IF NEW.summary_revision<>OLD.summary_revision THEN NEW.summary_stale:=true; END IF;
  RETURN NEW;
END;
$$;
-- New company schemas clone the public table and trigger through the existing initializer.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.initialize_organization_schema(uuid)'::regprocedure) INTO definition;
  definition := replace(definition, '''interview_stage_reviews'',', '''interview_summary_versions'', ''interview_stage_reviews'',');
  EXECUTE definition;
END;
$$;
DO $$
DECLARE target record; queue text;
BEGIN
  FOR target IN SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='r' AND c.relname='interview_live_sessions'
      AND (n.nspname='public' OR n.nspname IN (SELECT schema_name FROM public.organization_schemas))
  LOOP
    EXECUTE format('ALTER TABLE %I.interview_live_sessions ADD COLUMN summary_stale boolean NOT NULL DEFAULT false',target.nspname);
    EXECUTE format('CREATE TABLE %I.interview_summary_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES %I.interview_live_sessions(id) ON DELETE CASCADE,
      organization_id uuid NOT NULL, revision integer NOT NULL, transcript_version_id uuid, report jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(session_id,revision))',target.nspname,target.nspname);
    EXECUTE format('CREATE TRIGGER preserve_interview_summary_version BEFORE UPDATE ON %I.interview_live_sessions FOR EACH ROW EXECUTE FUNCTION public.preserve_interview_summary_version()',target.nspname);
    FOREACH queue IN ARRAY ARRAY['interview_audio_transcription_jobs','interview_transcript_postprocess_jobs'] LOOP
      EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I',target.nspname,queue,queue||'_status_check');
      EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK(status IN (''pending'',''processing'',''completed'',''failed''))',target.nspname,queue,queue||'_status_check');
    END LOOP;
  END LOOP;
END;
$$;
