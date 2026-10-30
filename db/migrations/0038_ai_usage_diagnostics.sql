-- Diagnostic metadata only. Historical states and generated results are not rewritten.
SET LOCAL lock_timeout = '5s';
ALTER TABLE ai_usage_tasks
 ADD COLUMN request_id text CHECK(request_id IS NULL OR request_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
 ADD COLUMN duration_ms integer CHECK(duration_ms IS NULL OR duration_ms>=0),
 ADD COLUMN failure_category text CHECK(failure_category IN ('upstream_rejected','request_timeout','network_error','invalid_response','generation_failed','settlement_failed'));
CREATE INDEX ai_usage_tasks_org_operation_state_time ON ai_usage_tasks(organization_id,operation,state,created_at DESC,id DESC);
CREATE TABLE ai_usage_review_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 task_id uuid NOT NULL REFERENCES ai_usage_tasks(id) ON DELETE CASCADE,
 actor_user_id uuid NOT NULL REFERENCES users(id),
 client_key uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('awaiting_provider','awaiting_result','evidence_recorded')),
 note text NOT NULL CHECK(char_length(note) BETWEEN 2 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,actor_user_id,client_key)
);
CREATE INDEX ai_usage_review_notes_task_created ON ai_usage_review_notes(task_id,created_at DESC,id DESC);
