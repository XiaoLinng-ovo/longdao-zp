-- Physical keys are never reused once deletion has been authorized, even after retries.
CREATE TABLE public.object_deletion_fences (
  storage_kind text NOT NULL CHECK (storage_kind IN ('resume','interview')),
  storage_key text NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  schema_name text NOT NULL CHECK (schema_name='public' OR schema_name='company_' || replace(organization_id::text,'-','')),
  location_id text NOT NULL CHECK (location_id ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (storage_kind,storage_key)
);

CREATE FUNCTION public.guard_object_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  object_kind text;
  object_key text;
  object_schema text;
  object_parent uuid;
  intent public.object_write_intents%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='resumes' THEN
    object_kind := 'resume';
    object_key := NEW.storage_key;
    object_parent := NEW.candidate_id;
    object_schema := TG_TABLE_SCHEMA;
  ELSIF TG_TABLE_NAME='interview_stored_objects' THEN
    object_kind := 'interview';
    object_key := COALESCE(NEW.physical_key,NEW.storage_key);
    object_parent := NEW.session_id;
    object_schema := NEW.schema_name;
  ELSE
    object_kind := 'interview';
    SELECT COALESCE(o.physical_key,o.storage_key) INTO object_key
      FROM public.interview_stored_objects o
     WHERE o.organization_id=NEW.organization_id AND o.session_id=NEW.session_id AND o.storage_key=NEW.object_key;
    object_key := COALESCE(object_key,NEW.object_key);
    object_parent := NEW.session_id;
    object_schema := TG_TABLE_SCHEMA;
  END IF;
  IF object_key IS NULL THEN RETURN NEW; END IF;
  IF object_schema<>'public' AND object_schema<>'company_' || replace(NEW.organization_id::text,'-','') THEN
    RAISE EXCEPTION 'OBJECT_REFERENCE_SCHEMA_MISMATCH' USING ERRCODE='23514';
  END IF;
  -- Cleanup takes the same lock before inspecting references and installing its fence.
  PERFORM pg_advisory_xact_lock(hashtextextended(object_kind || '-object:' || object_key,0));
  IF EXISTS (SELECT 1 FROM public.object_deletion_fences WHERE storage_kind=object_kind AND storage_key=object_key) THEN
    RAISE EXCEPTION 'OBJECT_REFERENCE_DELETION_FENCED' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stored_object_locations WHERE storage_kind=object_kind AND storage_key=object_key AND organization_id<>NEW.organization_id) THEN
    RAISE EXCEPTION 'OBJECT_REFERENCE_OWNER_MISMATCH' USING ERRCODE='23514';
  END IF;
  SELECT * INTO intent FROM public.object_write_intents WHERE storage_key=object_key;
  IF FOUND AND (intent.status<>'bound' OR intent.organization_id<>NEW.organization_id
      OR intent.schema_name<>object_schema OR intent.storage_kind<>object_kind OR intent.parent_id<>object_parent) THEN
    RAISE EXCEPTION 'OBJECT_REFERENCE_INTENT_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_object_reference BEFORE INSERT OR UPDATE ON public.interview_stored_objects
  FOR EACH ROW EXECUTE FUNCTION public.guard_object_reference();
DO $$
DECLARE target record;
BEGIN
  -- New company schemas copy these public triggers through initialize_organization_schema.
  FOR target IN
    SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE c.relkind='r' AND c.relname IN ('resumes','interview_audio_recordings')
       AND (n.nspname='public' OR n.nspname IN (SELECT schema_name FROM public.organization_schemas))
  LOOP
    EXECUTE format('CREATE TRIGGER guard_object_reference BEFORE INSERT OR UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.guard_object_reference()',target.nspname,target.relname);
  END LOOP;
END;
$$;
