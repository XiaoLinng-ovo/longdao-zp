-- Simulation only: these tables never update organizations' real subscription/capacity.
CREATE TABLE billing_sandbox_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 actor_id uuid NOT NULL REFERENCES users(id), idempotency_key text NOT NULL, fingerprint text NOT NULL,
 product_code text NOT NULL, plan_version_id uuid NOT NULL REFERENCES subscription_plan_versions(id),
 product_name text NOT NULL, seat_limit integer NOT NULL, job_limit integer NOT NULL,
 amount_fen integer NOT NULL CHECK(amount_fen>0), currency text NOT NULL CHECK(currency='CNY'),
 duration_days integer NOT NULL CHECK(duration_days>0), channel text NOT NULL CHECK(channel IN ('mock_alipay','mock_wechat')),
 expected_version integer NOT NULL CHECK(expected_version>0),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','failed','fulfilled','review','refunded','expired','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 paid_at timestamptz, refunded_at timestamptz, transaction_id text UNIQUE,
 UNIQUE(organization_id,actor_id,idempotency_key), UNIQUE(id,organization_id)
);
CREATE INDEX billing_sandbox_orders_org_idx ON billing_sandbox_orders(organization_id,created_at DESC,id DESC);
CREATE TABLE billing_sandbox_entitlements (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 active_order_id uuid, plan_version_id uuid REFERENCES subscription_plan_versions(id), expires_at timestamptz,
 FOREIGN KEY(active_order_id,organization_id) REFERENCES billing_sandbox_orders(id,organization_id),
 CHECK((active_order_id IS NULL AND plan_version_id IS NULL AND expires_at IS NULL) OR
       (active_order_id IS NOT NULL AND plan_version_id IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE TABLE billing_sandbox_events (
 event_id text PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), order_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL CHECK(kind IN ('success','failure','refund','expire','cancel')),
 fingerprint text NOT NULL, payload jsonb NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('applied','ignored','review')),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(order_id,organization_id) REFERENCES billing_sandbox_orders(id,organization_id), UNIQUE(order_id,kind)
);
CREATE INDEX billing_sandbox_events_org_idx ON billing_sandbox_events(organization_id,created_at DESC);
