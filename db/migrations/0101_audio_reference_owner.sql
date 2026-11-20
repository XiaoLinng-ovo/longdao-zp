-- Recordings inherit their company from the session's interview, not a column on the recording.
CREATE OR REPLACE FUNCTION public.guard_object_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  object_kind text;
  object_key text;
  object_schema text;
  object_parent uuid;
  object_organization uuid;
  intent public.object_write_intents%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='resumes' THEN
    object_kind := 'resume';
    object_key := NEW.storage_key;
    object_parent := NEW.candidate_id;
    object_schema := TG_TABLE_SCHEMA;
    object_organization := NEW.organization_id;
  ELSIF TG_TABLE_NAME='interview_stored_objects' AND TG_TABLE_SCHEMA='public' THEN
    object_kind := 'interview';
    object_key := COALESCE(NEW.physical_key,NEW.storage_key);
    object_parent := NEW.session_id;
    object_schema := NEW.schema_name;
    object_organization := NEW.organization_id;
  ELSIF TG_TABLE_NAME='interview_audio_recordings' THEN
    object_kind := 'interview';
    object_parent := NEW.session_id;
    object_schema := TG_TABLE_SCHEMA;
    EXECUTE format('SELECT i.organization_id FROM %I.interview_live_sessions s JOIN %I.interviews i ON i.id=s.interview_id WHERE s.id=$1',object_schema,object_schema)
      INTO object_organization USING object_parent;
    IF object_organization IS NULL THEN
      RAISE EXCEPTION 'OBJECT_REFERENCE_OWNER_MISSING' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(o.physical_key,o.storage_key) INTO object_key
      FROM public.interview_stored_objects o
     WHERE o.organization_id=object_organization AND o.schema_name=object_schema
       AND o.session_id=object_parent AND o.storage_key=NEW.object_key;
    object_key := COALESCE(object_key,NEW.object_key);
  ELSE
    RAISE EXCEPTION 'OBJECT_REFERENCE_TABLE_UNSUPPORTED' USING ERRCODE='23514';
  END IF;
  IF object_key IS NULL THEN RETURN NEW; END IF;
  IF object_organization IS NULL OR (object_schema<>'public' AND object_schema<>'company_' || replace(object_organization::text,'-','')) THEN
    RAISE EXCEPTION 'OBJECT_REFERENCE_SCHEMA_MISMATCH' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(object_kind || '-object:' || object_key,0));
  IF EXISTS (SELECT 1 FROM public.object_deletion_fences WHERE storage_kind=object_kind AND storage_key=object_key) THEN
    RAISE EXCEPTION 'OBJECT_REFERENCE_DELETION_FENCED' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stored_object_locations WHERE storage_kind=object_kind AND storage_key=object_key AND organization_id<>object_organization) THEN
    RAISE EXCEPTION 'OBJECT_REFERENCE_OWNER_MISMATCH' USING ERRCODE='23514';
  END IF;
  SELECT * INTO intent FROM public.object_write_intents WHERE storage_key=object_key;
  IF FOUND AND (intent.status<>'bound' OR intent.organization_id<>object_organization
      OR intent.schema_name<>object_schema OR intent.storage_kind<>object_kind OR intent.parent_id<>object_parent) THEN
    RAISE EXCEPTION 'OBJECT_REFERENCE_INTENT_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
