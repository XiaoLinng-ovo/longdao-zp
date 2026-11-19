CREATE TABLE public.object_cleanup_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  storage_key text NOT NULL,
  schema_name text NOT NULL CHECK (schema_name = 'public' OR schema_name ~ '^company_[0-9a-f]{32}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, storage_key)
);
CREATE INDEX object_cleanup_pending ON public.object_cleanup_tasks(available_at, id) WHERE status='pending';

CREATE TABLE public.offer_email_deliveries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  offer_id uuid NOT NULL,
  version_id uuid NOT NULL,
  workflow_version integer NOT NULL,
  message_id text NOT NULL UNIQUE,
  schema_name text NOT NULL CHECK (schema_name = 'public' OR schema_name ~ '^company_[0-9a-f]{32}$'),
  send_request jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('sending','accepted','unknown','completed','not_sent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES public.users(id),
  resolution_note text
);
CREATE UNIQUE INDEX offer_email_idempotency ON public.offer_email_deliveries(organization_id,offer_id,version_id,workflow_version) WHERE status <> 'not_sent';
CREATE UNIQUE INDEX offer_email_unresolved ON public.offer_email_deliveries(organization_id,offer_id)
  WHERE status IN ('sending','accepted','unknown');
CREATE INDEX offer_email_status ON public.offer_email_deliveries(status,updated_at);

-- Existing company schemas also need the import-history columns added in 0090.
DO $$
DECLARE target_schema record;
BEGIN
  FOR target_schema IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^company_[0-9a-f]{32}$'
  LOOP
    IF to_regclass(format('%I.resume_import_batches', target_schema.nspname)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.resume_import_batches ALTER COLUMN job_id DROP NOT NULL, ADD COLUMN IF NOT EXISTS detached_job_id uuid, ADD COLUMN IF NOT EXISTS detached_job_title text, ADD COLUMN IF NOT EXISTS detached_at timestamptz', target_schema.nspname);
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION public.organization_business_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[
    'ai_resume_scoring_skill_jobs', 'analysis_results', 'analysis_tasks', 'applications',
    'approval_instances', 'approval_records', 'approval_steps', 'audit_logs', 'candidates',
    'channel_resume_events', 'channel_sync_runs', 'department_approval_policies',
    'enterprise_ai_settings', 'external_entity_mappings', 'external_event_receipts',
    'idempotency_records', 'interview_audio_recordings', 'interview_audio_transcription_jobs',
    'interview_feedback', 'interview_live_analyses', 'interview_live_question_events',
    'interview_live_segments', 'interview_live_sessions', 'interview_question_preparations',
    'interview_question_sheets', 'interview_questions', 'interview_resume_question_sets',
    'interview_stage_reviews', 'interview_transcript_postprocess_jobs', 'interview_transcript_versions',
    'interviews', 'job_channel_publications', 'job_description_versions', 'job_spec_versions', 'jobs',
    'offer_templates', 'offer_versions', 'offers', 'onboarding_integrations', 'onboarding_materials',
    'onboarding_records', 'onboarding_reminders', 'onboarding_tasks', 'outbox_events',
    'recruitment_requests', 'resume_import_batches', 'resume_import_items', 'resumes',
    'workflow_events'
  ] $$;

-- Fail closed instead of resolving a missing company table from public.
CREATE FUNCTION public.organization_schema_structure_ready(p_organization_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  WITH expected AS (
    SELECT name, to_regclass(format('public.%I',name)) AS source,
      to_regclass(format('%I.%I',public.organization_schema_name(p_organization_id),name)) AS target
    FROM unnest(public.organization_business_tables()) AS name
  )
  SELECT NOT EXISTS (
    SELECT 1 FROM expected WHERE source IS NULL OR target IS NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM expected e
    JOIN pg_attribute a ON a.attrelid=e.source AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attribute b ON b.attrelid=e.target AND b.attname=a.attname AND b.attnum>0 AND NOT b.attisdropped
    WHERE b.attname IS NULL OR (b.atttypid,b.atttypmod,b.attnotnull) IS DISTINCT FROM (a.atttypid,a.atttypmod,a.attnotnull)
  )
$$;
