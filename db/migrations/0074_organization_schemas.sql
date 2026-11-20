-- 企业业务数据使用独立 PostgreSQL Schema；组织、用户、成员和平台能力仍保留在 public。
-- Schema 名只由组织 UUID 确定性生成，绝不使用企业名称或客户端输入。
CREATE OR REPLACE FUNCTION public.organization_schema_name(p_organization_id uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT 'company_' || replace(lower(p_organization_id::text), '-', '')
$$;

CREATE TABLE IF NOT EXISTS public.organization_schemas (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE RESTRICT,
  schema_name text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'initializing', 'ready', 'failed', 'disabled')),
  error_message text,
  initialized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (schema_name ~ '^company_[0-9a-f]{32}$'),
  CHECK (schema_name = public.organization_schema_name(organization_id))
);

CREATE INDEX IF NOT EXISTS organization_schemas_status_idx
  ON public.organization_schemas(status, updated_at);

-- Preserve an audit of legacy-default ownership repairs; never transfer an explicitly owned row.
CREATE TABLE IF NOT EXISTS public.organization_schema_repairs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  record_key jsonb NOT NULL,
  previous_organization_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  repaired_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  relation record;
  changed bigint;
  legacy constant uuid := '00000000-0000-4000-8000-000000000028';
BEGIN
  -- Parent order matters: sessions precede their segments and analyses.
  FOR relation IN SELECT * FROM (VALUES
    ('resumes', 'candidates', 'candidate_id'),
    ('analysis_tasks', 'resumes', 'resume_id'),
    ('analysis_results', 'analysis_tasks', 'analysis_task_id'),
    ('analysis_results', 'resumes', 'resume_id'),
    ('interview_live_sessions', 'interviews', 'interview_id'),
    ('interview_question_sheets', 'applications', 'application_id'),
    ('interview_questions', 'interview_question_sheets', 'sheet_id'),
    ('interview_resume_question_sets', 'interviews', 'interview_id'),
    ('interview_stage_reviews', 'applications', 'application_id'),
    ('interview_live_segments', 'interview_live_sessions', 'session_id'),
    ('interview_live_analyses', 'interview_live_segments', 'segment_id'),
    ('interview_live_question_events', 'interview_live_sessions', 'session_id'),
    ('interview_questions', 'interview_live_question_events', 'question_event_id')
  ) AS owned(child_table, parent_table, parent_key)
  LOOP
    EXECUTE format(
      'WITH repaired AS (
        UPDATE public.%I c SET organization_id=p.organization_id FROM public.%I p
        WHERE c.%I=p.id AND c.organization_id=$1 AND p.organization_id<>$1
        RETURNING to_jsonb(c)-''organization_id'' AS record, c.organization_id
      ) INSERT INTO public.organization_schema_repairs(table_name,record_key,previous_organization_id,organization_id)
        SELECT $2, jsonb_strip_nulls(jsonb_build_object(''id'',record->''id'',
          ''interview_id'',record->''interview_id'',''application_id'',record->''application_id'')),
          $1,organization_id FROM repaired', relation.child_table, relation.parent_table, relation.parent_key
    ) USING legacy, relation.child_table;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed > 0 THEN RAISE NOTICE 'Legacy ownership repaired: % (%)', relation.child_table, changed; END IF;
  END LOOP;

  -- Reject any remaining conflicting ownership, including parents not listed above.
  FOR relation IN
    SELECT child_namespace.nspname AS child_schema,
      c.relname AS child_table, parent_namespace.nspname AS parent_schema,
      p.relname AS parent_table, co.conname,
      string_agg(format('c.%I=p.%I', ca.attname, pa.attname), ' AND ' ORDER BY keys.ordinality) AS join_sql
    FROM pg_constraint co
    JOIN pg_class c ON c.oid=co.conrelid
    JOIN pg_namespace child_namespace ON child_namespace.oid=c.relnamespace
    JOIN pg_class p ON p.oid=co.confrelid
    JOIN pg_namespace parent_namespace ON parent_namespace.oid=p.relnamespace
    CROSS JOIN LATERAL unnest(co.conkey,co.confkey) WITH ORDINALITY AS keys(child_key,parent_key,ordinality)
    JOIN pg_attribute ca ON ca.attrelid=c.oid AND ca.attnum=keys.child_key
    JOIN pg_attribute pa ON pa.attrelid=p.oid AND pa.attnum=keys.parent_key
    WHERE co.contype='f'
      AND co.connamespace='public'::regnamespace
      AND child_namespace.nspname='public'
      AND parent_namespace.nspname='public'
      AND p.relname<>'organizations'
      AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=c.oid AND attname='organization_id' AND NOT attisdropped)
      AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=p.oid AND attname='organization_id' AND NOT attisdropped)
    GROUP BY child_namespace.nspname,c.relname,parent_namespace.nspname,p.relname,co.conname
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I c JOIN %I.%I p ON %s WHERE c.organization_id IS DISTINCT FROM p.organization_id',
      relation.child_schema,relation.child_table,relation.parent_schema,relation.parent_table,relation.join_sql) INTO changed;
    IF changed<>0 THEN RAISE EXCEPTION 'CROSS_ORGANIZATION_REFERENCE: % (%)',relation.conname,changed; END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.initialize_organization_schema(p_organization_id uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  business_tables constant text[] := ARRAY[
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
  ];
  target_table text;
  schema_name text;
  current_status text;
  organization_status text;
  expected_count bigint;
  copied_count bigint;
  constraint_row record;
  trigger_row record;
  source_expression text;
  previous_search_path text := current_setting('search_path');
BEGIN
  SELECT status INTO organization_status
    FROM public.organizations
   WHERE id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND';
  END IF;

  schema_name := public.organization_schema_name(p_organization_id);
  PERFORM pg_advisory_xact_lock(hashtext('organization-schema:' || p_organization_id::text));

  SELECT status INTO current_status
    FROM public.organization_schemas
   WHERE organization_id = p_organization_id
   FOR UPDATE;

  IF current_status = 'ready' AND organization_status <> 'archived'
     AND to_regnamespace(schema_name) IS NOT NULL THEN
    RETURN schema_name;
  END IF;

  IF current_status = 'disabled' AND organization_status = 'archived'
     AND to_regnamespace(schema_name) IS NOT NULL THEN
    RETURN schema_name;
  END IF;

  INSERT INTO public.organization_schemas (organization_id, schema_name, status)
  VALUES (p_organization_id, schema_name, 'initializing')
  ON CONFLICT (organization_id) DO UPDATE
    SET schema_name = EXCLUDED.schema_name,
        status = 'initializing',
        error_message = NULL,
        updated_at = now();

  -- 重试失败或结构不完整的初始化时，只允许删除确定性企业 Schema。
  IF NOT schema_name ~ '^company_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'INVALID_ORGANIZATION_SCHEMA_NAME';
  END IF;
  IF to_regnamespace(schema_name) IS NOT NULL THEN
    RAISE EXCEPTION 'ORGANIZATION_SCHEMA_ALREADY_EXISTS: %', schema_name;
  END IF;
  EXECUTE format('CREATE SCHEMA %I', schema_name);

  FOREACH target_table IN ARRAY business_tables LOOP
    EXECUTE format(
      'CREATE TABLE %I.%I (LIKE public.%I INCLUDING ALL)',
      schema_name, target_table, target_table
    );

    CASE target_table
      WHEN 'external_entity_mappings', 'external_event_receipts' THEN
        -- 这两张表没有可靠的企业外键，历史公共数据无法判定归属，新企业从空表开始。
        source_expression := 'SELECT * FROM public.' || quote_ident(target_table) || ' WHERE false';
      WHEN 'ai_resume_scoring_skill_jobs' THEN
        source_expression := 'SELECT s.* FROM public.ai_resume_scoring_skill_jobs s '
          || 'JOIN public.jobs j ON j.id = s.job_id WHERE j.organization_id = $1';
      WHEN 'department_approval_policies' THEN
        source_expression := 'SELECT p.* FROM public.department_approval_policies p '
          || 'JOIN public.departments d ON d.id = p.department_id WHERE d.organization_id = $1';
      WHEN 'interview_audio_recordings' THEN
        source_expression := 'SELECT a.* FROM public.interview_audio_recordings a '
          || 'JOIN public.interview_live_sessions s ON s.id = a.session_id WHERE s.organization_id = $1';
      WHEN 'interview_audio_transcription_jobs' THEN
        source_expression := 'SELECT a.* FROM public.interview_audio_transcription_jobs a '
          || 'JOIN public.interview_live_sessions s ON s.id = a.session_id WHERE s.organization_id = $1';
      WHEN 'interview_question_preparations' THEN
        source_expression := 'SELECT p.* FROM public.interview_question_preparations p '
          || 'JOIN public.interviews i ON i.id = p.interview_id WHERE i.organization_id = $1';
      WHEN 'interview_transcript_versions' THEN
        source_expression := 'SELECT v.* FROM public.interview_transcript_versions v '
          || 'JOIN public.interview_live_sessions s ON s.id = v.session_id WHERE s.organization_id = $1';
      WHEN 'interview_transcript_postprocess_jobs' THEN
        source_expression := 'SELECT j.* FROM public.interview_transcript_postprocess_jobs j '
          || 'JOIN public.interview_live_sessions s ON s.id = j.session_id WHERE s.organization_id = $1';
      ELSE
        IF EXISTS (
          SELECT 1 FROM pg_attribute
           WHERE attrelid = format('public.%I', target_table)::regclass
             AND attname = 'organization_id'
             AND NOT attisdropped
        ) THEN
          source_expression := 'SELECT * FROM public.' || quote_ident(target_table) || ' WHERE organization_id = $1';
        ELSE
          RAISE EXCEPTION 'BUSINESS_TABLE_OWNERSHIP_UNKNOWN: %', target_table;
        END IF;
    END CASE;

    EXECUTE format(
      'INSERT INTO %I.%I OVERRIDING SYSTEM VALUE %s',
      schema_name, target_table, source_expression
    ) USING p_organization_id;
    GET DIAGNOSTICS copied_count = ROW_COUNT;
    EXECUTE format('SELECT count(*) FROM %I.%I', schema_name, target_table)
      INTO expected_count;
    IF copied_count <> expected_count THEN
      RAISE EXCEPTION 'ORGANIZATION_SCHEMA_COPY_COUNT_MISMATCH: % (% <> %)',
        target_table, copied_count, expected_count;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = format('public.%I', target_table)::regclass
         AND attname = 'organization_id'
         AND NOT attisdropped
    ) THEN
      EXECUTE format(
        'SELECT count(*) FROM %I.%I WHERE organization_id IS DISTINCT FROM $1',
        schema_name, target_table
      ) INTO expected_count USING p_organization_id;
      IF expected_count <> 0 THEN
        RAISE EXCEPTION 'ORGANIZATION_SCHEMA_TENANT_MISMATCH: %', target_table;
      END IF;
      EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN organization_id SET DEFAULT %L::uuid',
        schema_name,target_table,p_organization_id);
      EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT tenant_ownership_check CHECK (organization_id=%L::uuid)',
        schema_name,target_table,p_organization_id);
    END IF;
  END LOOP;

  -- 外键定义来自控制面，但业务目标必须解析到企业 Schema，公共控制目标解析到 public。
  PERFORM set_config('search_path', format('%I,public', schema_name), true);
  FOR constraint_row IN
    SELECT source_table.relname AS source_table,
           target_table.relname AS target_table,
           con.conname,
           CASE WHEN target_namespace.nspname = 'public'
                  AND target_table.relname = ANY (business_tables)
                THEN replace(
                  pg_get_constraintdef(con.oid),
                  format('REFERENCES public.%I', target_table.relname),
                  format('REFERENCES %I', target_table.relname)
                )
                ELSE pg_get_constraintdef(con.oid)
           END AS definition
      FROM pg_constraint con
      JOIN pg_class source_table ON source_table.oid = con.conrelid
      JOIN pg_namespace source_namespace ON source_namespace.oid = source_table.relnamespace
      JOIN pg_class target_table ON target_table.oid = con.confrelid
      JOIN pg_namespace target_namespace ON target_namespace.oid = target_table.relnamespace
     WHERE con.contype = 'f'
       AND source_namespace.nspname = 'public'
       AND source_table.relname = ANY (business_tables)
     ORDER BY source_table.relname, con.conname
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I %s',
      schema_name, constraint_row.source_table, constraint_row.conname, constraint_row.definition
    );
  END LOOP;

  -- LIKE INCLUDING ALL 不复制用户触发器；公共函数仍通过 public 搜索路径解析。
  FOR trigger_row IN
    SELECT table_class.relname AS table_name,
           replace(
             pg_get_triggerdef(trigger.oid, true),
             ' ON public.' || quote_ident(table_class.relname),
             ' ON ' || quote_ident(table_class.relname)
           ) AS definition
      FROM pg_trigger trigger
      JOIN pg_class table_class ON table_class.oid = trigger.tgrelid
      JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
     WHERE NOT trigger.tgisinternal
       AND table_namespace.nspname = 'public'
       AND table_class.relname = ANY (business_tables)
     ORDER BY table_class.relname, trigger.tgname
  LOOP
    EXECUTE trigger_row.definition;
  END LOOP;

  PERFORM set_config('search_path', previous_search_path, true);

  UPDATE public.organization_schemas
     SET status = CASE WHEN organization_status = 'archived' THEN 'disabled' ELSE 'ready' END,
         error_message = NULL,
         initialized_at = now(),
         updated_at = now()
   WHERE organization_id = p_organization_id;

  RETURN schema_name;
EXCEPTION WHEN OTHERS THEN
  -- 调用方可把失败状态记录到独立事务；表、注册和 DDL 本身必须整体回滚。
  RAISE;
END;
$$;

DO $$
DECLARE
  organization_row record;
BEGIN
  FOR organization_row IN
    SELECT id FROM public.organizations ORDER BY id
  LOOP
    PERFORM public.initialize_organization_schema(organization_row.id);
  END LOOP;
END;
$$;
