-- BYOK generation telemetry only: no price, credit balance, or monetary deductions.
CREATE TABLE ai_usage_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 actor_user_id uuid NOT NULL REFERENCES users(id),
 operation text NOT NULL CHECK (operation IN ('job_spec','jd')),
 resource_id uuid NOT NULL,
 idempotency_key text NOT NULL,
 fingerprint text NOT NULL,
 model text NOT NULL,
 billing_source text NOT NULL DEFAULT 'customer_model' CHECK (billing_source='customer_model'),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','released','uncertain')),
 reserved_units integer NOT NULL DEFAULT 1 CHECK(reserved_units=1),
 settled_units integer NOT NULL DEFAULT 0 CHECK(settled_units IN (0,1)),
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 CHECK ((state='settled' AND settled_units=1 AND result IS NOT NULL) OR (state<>'settled' AND settled_units=0 AND result IS NULL)),
 UNIQUE(organization_id,actor_user_id,operation,resource_id,idempotency_key)
);
CREATE INDEX ai_usage_tasks_enterprise_created ON ai_usage_tasks(organization_id,created_at DESC);
