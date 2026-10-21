-- Enterprise data isolation foundation.
-- The fixed legacy workspace is an explicit quarantine for records that existed
-- before workspace support. New tenant-scoped writes must provide organization_id.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = '00000000-0000-4000-8000-000000000028'::uuid) THEN
    INSERT INTO organizations (id, name, kind, status)
    VALUES ('00000000-0000-4000-8000-000000000028', '历史迁移工作空间', 'test', 'active');
  END IF;
END $$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'recruitment_requests', 'approval_instances', 'approval_steps', 'approval_records',
    'jobs', 'job_spec_versions', 'job_description_versions',
    'candidates', 'applications', 'resumes', 'analysis_tasks', 'analysis_results',
    'workflow_events', 'outbox_events', 'audit_logs', 'idempotency_records',
    'interviews', 'interview_feedback', 'offers', 'offer_versions', 'onboarding_records',
    'interview_live_sessions', 'interview_live_segments', 'interview_live_analyses',
    'interview_live_question_events', 'job_channel_publications', 'channel_resume_events',
    'channel_sync_runs', 'interview_question_sheets', 'interview_questions',
    'interview_stage_reviews', 'interview_resume_question_sets'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN IF NOT EXISTS organization_id uuid NOT NULL DEFAULT %L::uuid REFERENCES organizations(id) ON DELETE RESTRICT',
        table_name, '00000000-0000-4000-8000-000000000028'
      );
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (organization_id)', table_name || '_organization_idx', table_name);
    END IF;
  END LOOP;
END $$;

-- Keep the legacy rows explicit and auditable. This is intentionally not assigned
-- to the first user-created company.
UPDATE recruitment_requests SET organization_id = '00000000-0000-4000-8000-000000000028'::uuid WHERE organization_id IS NULL;
