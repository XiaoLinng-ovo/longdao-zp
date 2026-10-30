-- Older releases saved "continue" without creating the independent final round.
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  app record;
  initial record;
  conclusion record;
  final_id uuid;
BEGIN
  FOR app IN
    SELECT a.id, a.organization_id, a.status
    FROM applications a
    WHERE a.status IN ('interviewing', 'human_review')
      AND EXISTS (SELECT 1 FROM interviews i WHERE i.application_id = a.id
        AND i.organization_id = a.organization_id AND i.stage = 'initial' AND i.status = 'completed')
      AND NOT EXISTS (SELECT 1 FROM interviews f WHERE f.application_id = a.id
        AND (f.stage = 'final' OR f.round >= 2))
    ORDER BY a.id
    FOR UPDATE OF a
  LOOP
    -- Match the live conclusion path's lock order: application, then interview.
    SELECT i.* INTO initial FROM interviews i
    WHERE i.application_id = app.id AND i.organization_id = app.organization_id
      AND i.stage = 'initial' AND i.status <> 'cancelled'
    ORDER BY i.round DESC, i.created_at DESC, i.id DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND OR initial.status <> 'completed' THEN CONTINUE; END IF;

    SELECT e.* INTO conclusion FROM workflow_events e
    WHERE e.subject_type = 'interview' AND e.subject_id = initial.id
      AND e.event_type = 'conclude' AND e.organization_id = app.organization_id
    ORDER BY e.created_at DESC, e.id DESC LIMIT 1;
    IF NOT FOUND OR conclusion.metadata->>'outcome' IS DISTINCT FROM 'continue' THEN CONTINUE; END IF;

    IF EXISTS (SELECT 1 FROM interviews f WHERE f.application_id = app.id
      AND (f.stage = 'final' OR f.round >= 2)) THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM interview_stage_reviews r WHERE r.application_id = app.id
      AND r.stage = 'initial' AND (r.organization_id IS DISTINCT FROM app.organization_id
        OR (r.decision IS NOT NULL AND r.decision <> 'advanced'))) THEN CONTINUE; END IF;

    final_id := gen_random_uuid();
    INSERT INTO interviews (id, application_id, interview_no, round, stage, type,
      title, status, timezone, participants, organization_id)
    VALUES (final_id, app.id, 'INT-' || upper(final_id::text), 2, 'final', initial.type,
      '第二轮复试', 'scheduled', initial.timezone, initial.participants, app.organization_id);

    INSERT INTO interview_stage_reviews (application_id, stage, decision, decided_by, decided_at, organization_id)
    VALUES (app.id, 'initial', 'advanced', conclusion.actor_user_id, conclusion.created_at, app.organization_id)
    ON CONFLICT (application_id, stage) DO UPDATE SET
      decision = 'advanced',
      decided_by = CASE WHEN interview_stage_reviews.decision = 'advanced'
        THEN interview_stage_reviews.decided_by ELSE EXCLUDED.decided_by END,
      decided_at = CASE WHEN interview_stage_reviews.decision = 'advanced'
        THEN interview_stage_reviews.decided_at ELSE EXCLUDED.decided_at END,
      updated_at = now();

    UPDATE applications SET status = 'interviewing', updated_at = now() WHERE id = app.id;
    INSERT INTO workflow_events (subject_type, subject_id, event_type, actor_user_id,
      from_status, to_status, reason, metadata, organization_id)
    VALUES ('application', app.id, 'advance_to_final_interview', conclusion.actor_user_id,
      app.status, 'interviewing', '补齐已完成初试的复试记录',
      jsonb_build_object('interviewId', final_id, 'round', 2, 'stage', 'final',
        'initialInterviewId', initial.id, 'conclusionEventId', conclusion.id, 'migration', '0047'),
      app.organization_id);
  END LOOP;
END $$;
