-- No company is cut over by installing this migration. Only reviewed maintenance writes these records.
CREATE SCHEMA recovery_control;
REVOKE ALL ON SCHEMA recovery_control FROM PUBLIC;

CREATE TABLE recovery_control.maintenance_receipts (
  plan_sha256 text PRIMARY KEY CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  intent text NOT NULL CHECK (intent IN ('reconcile','seal')),
  approved_by text NOT NULL CHECK (length(trim(approved_by)) > 0),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE recovery_control.company_data_cutovers (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),
  schema_name text NOT NULL UNIQUE,
  plan_sha256 text NOT NULL UNIQUE REFERENCES recovery_control.maintenance_receipts(plan_sha256),
  legacy_baseline jsonb NOT NULL CHECK (jsonb_typeof(legacy_baseline)='array' AND jsonb_array_length(legacy_baseline)>0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (schema_name='company_' || replace(organization_id::text,'-',''))
);
REVOKE ALL ON ALL TABLES IN SCHEMA recovery_control FROM PUBLIC;

CREATE FUNCTION recovery_control.guard_maintenance_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MAINTENANCE_RECORD_IMMUTABLE'; END IF;
  IF TG_TABLE_NAME='company_data_cutovers' THEN
    IF NOT EXISTS (SELECT 1 FROM recovery_control.maintenance_receipts r
      WHERE r.plan_sha256=NEW.plan_sha256 AND r.organization_id=NEW.organization_id AND r.intent='seal')
      OR NOT EXISTS (SELECT 1 FROM public.organization_schemas s
        WHERE s.organization_id=NEW.organization_id AND s.schema_name=NEW.schema_name AND s.status='ready')
      OR NOT public.organization_schema_structure_ready(NEW.organization_id) THEN
      RAISE EXCEPTION 'CUTOVER_RECEIPT_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER maintenance_receipt_immutable BEFORE INSERT OR UPDATE OR DELETE ON recovery_control.maintenance_receipts
  FOR EACH ROW EXECUTE FUNCTION recovery_control.guard_maintenance_record();
CREATE TRIGGER company_cutover_immutable BEFORE INSERT OR UPDATE OR DELETE ON recovery_control.company_data_cutovers
  FOR EACH ROW EXECUTE FUNCTION recovery_control.guard_maintenance_record();
CREATE TRIGGER maintenance_receipt_no_truncate BEFORE TRUNCATE ON recovery_control.maintenance_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION recovery_control.guard_maintenance_record();
CREATE TRIGGER company_cutover_no_truncate BEFORE TRUNCATE ON recovery_control.company_data_cutovers
  FOR EACH STATEMENT EXECUTE FUNCTION recovery_control.guard_maintenance_record();
REVOKE ALL ON FUNCTION recovery_control.guard_maintenance_record() FROM PUBLIC;

CREATE FUNCTION public.read_company_data_cutover(target uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object('planSha256',c.plan_sha256,'legacyBaseline',c.legacy_baseline,'recordedAt',c.recorded_at)
  FROM recovery_control.company_data_cutovers c JOIN recovery_control.maintenance_receipts r USING(plan_sha256)
  WHERE c.organization_id=target AND r.organization_id=target AND r.intent='seal'
$$;

-- Scoped legacy writes are rejected after sealing; public platform tables are not frozen.
CREATE FUNCTION public.guard_company_legacy_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE row_data jsonb; org uuid; parent_table text; parent_key text; candidates jsonb[];
BEGIN
  IF TG_TABLE_SCHEMA<>'public' THEN
    IF TG_OP='TRUNCATE' THEN RETURN NULL; END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM recovery_control.company_data_cutovers) THEN RAISE EXCEPTION 'LEGACY_SNAPSHOT_READ_ONLY'; END IF;
    RETURN NULL;
  END IF;
  -- Shared department metadata remains editable; only ownership/deletion can change the scoped legacy selection.
  IF TG_TABLE_NAME='departments' THEN
    IF TG_OP='INSERT' THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='INSERT' THEN candidates:=ARRAY[to_jsonb(NEW)];
  ELSIF TG_OP='DELETE' THEN candidates:=ARRAY[to_jsonb(OLD)];
  ELSE candidates:=ARRAY[to_jsonb(OLD),to_jsonb(NEW)]; END IF;
  FOREACH row_data IN ARRAY candidates LOOP
    org:=NULL;
    IF row_data ? 'organization_id' THEN org:=(row_data->>'organization_id')::uuid;
    ELSE
      CASE TG_TABLE_NAME
        WHEN 'ai_resume_scoring_skill_jobs' THEN parent_table:='jobs'; parent_key:='job_id';
        WHEN 'department_approval_policies' THEN parent_table:='departments'; parent_key:='department_id';
        WHEN 'interview_question_preparations' THEN parent_table:='interviews'; parent_key:='interview_id';
        WHEN 'interview_audio_recordings','interview_audio_transcription_jobs','interview_transcript_versions','interview_transcript_postprocess_jobs'
          THEN parent_table:='interview_live_sessions'; parent_key:='session_id';
        ELSE RAISE EXCEPTION 'LEGACY_OWNERSHIP_UNKNOWN';
      END CASE;
      EXECUTE format('SELECT organization_id FROM public.%I WHERE id=$1',parent_table) INTO org USING (row_data->>parent_key)::uuid;
    END IF;
    IF EXISTS(SELECT 1 FROM recovery_control.company_data_cutovers WHERE organization_id=org) THEN
      RAISE EXCEPTION 'LEGACY_SNAPSHOT_READ_ONLY';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

-- Departments anchor ownership of department_approval_policies in the frozen snapshot.
CREATE TRIGGER company_legacy_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON public.departments
  FOR EACH ROW EXECUTE FUNCTION public.guard_company_legacy_snapshot();
CREATE TRIGGER company_legacy_snapshot_no_truncate BEFORE TRUNCATE ON public.departments
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_company_legacy_snapshot();
REVOKE ALL ON FUNCTION public.guard_company_legacy_snapshot() FROM PUBLIC;

DO $$
DECLARE target text; schema_row record;
BEGIN
  FOREACH target IN ARRAY public.organization_business_tables() LOOP
    -- Globally scoped legacy integration receipts cannot be attributed to a company here.
    IF target IN ('external_entity_mappings','external_event_receipts') THEN CONTINUE; END IF;
    FOR schema_row IN SELECT 'public' AS name UNION ALL SELECT schema_name FROM public.organization_schemas LOOP
      EXECUTE format('CREATE TRIGGER company_legacy_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.guard_company_legacy_snapshot()',schema_row.name,target);
      EXECUTE format('CREATE TRIGGER company_legacy_snapshot_no_truncate BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_company_legacy_snapshot()',schema_row.name,target);
    END LOOP;
  END LOOP;
END;
$$;
