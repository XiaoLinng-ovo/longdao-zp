-- Real merchant payments are isolated from the simulation ledger. No prices are seeded.
CREATE TABLE payment_products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_version_id uuid NOT NULL REFERENCES subscription_plan_versions(id),
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 80), amount_fen integer NOT NULL CHECK(amount_fen BETWEEN 1 AND 100000000),
 currency text NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'), duration_days integer NOT NULL CHECK(duration_days BETWEEN 1 AND 3660),
 active boolean NOT NULL DEFAULT false, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION immutable_payment_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.plan_version_id,NEW.name,NEW.amount_fen,NEW.currency,NEW.duration_days) IS DISTINCT FROM
    ROW(OLD.plan_version_id,OLD.name,OLD.amount_fen,OLD.currency,OLD.duration_days) THEN
   RAISE EXCEPTION 'Publish a new price version instead of changing a sold product';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER immutable_payment_product BEFORE UPDATE ON payment_products FOR EACH ROW EXECUTE FUNCTION immutable_payment_product();
CREATE TABLE payment_providers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(name) BETWEEN 2 AND 80),
 kind text NOT NULL CHECK(kind IN ('wxpay','alipay','easypay')), enabled boolean NOT NULL DEFAULT false,
 config_ciphertext text NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payment_orders (
 id uuid PRIMARY KEY, out_trade_no text NOT NULL UNIQUE, organization_id uuid NOT NULL REFERENCES organizations(id),
 actor_id uuid NOT NULL REFERENCES users(id), product_id uuid NOT NULL REFERENCES payment_products(id),
 provider_id uuid NOT NULL REFERENCES payment_providers(id), method text NOT NULL CHECK(method IN ('wxpay','alipay')),
 mode text NOT NULL CHECK(mode IN ('qrcode','redirect')), amount_fen integer NOT NULL CHECK(amount_fen>0), currency text NOT NULL CHECK(currency='CNY'),
 product_name text NOT NULL, plan_version_id uuid NOT NULL REFERENCES subscription_plan_versions(id), duration_days integer NOT NULL,
 expected_version integer NOT NULL, idempotency_key text NOT NULL, fingerprint text NOT NULL,
 status text NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','pending','uncertain','fulfilled','review','cancelled','expired','refund_pending','refunded')),
 pay_url text, qr_code text, transaction_id text, paid_at timestamptz, fulfilled_at timestamptz, refunded_at timestamptz,
 refund_id text, refund_reason text, refund_actor_id uuid REFERENCES users(id), last_checked_at timestamptz,
 before_entitlements jsonb, after_version integer, review_reason text,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 UNIQUE(organization_id,actor_id,idempotency_key), UNIQUE(provider_id,transaction_id)
);
CREATE INDEX payment_orders_org_idx ON payment_orders(organization_id,created_at DESC);
CREATE INDEX payment_orders_reconcile_idx ON payment_orders(status,last_checked_at);
CREATE TABLE payment_events (
 id bigserial PRIMARY KEY, order_id uuid NOT NULL REFERENCES payment_orders(id), event_key text NOT NULL UNIQUE,
 source text NOT NULL CHECK(source IN ('callback','query','refund')), metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE organizations ADD COLUMN paid_subscription_expires_at timestamptz;
ALTER TABLE organizations ADD COLUMN active_payment_order_id uuid REFERENCES payment_orders(id);
CREATE OR REPLACE FUNCTION organization_service_available(target_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM organizations o WHERE o.id=target_id AND o.status='active' AND o.service_status<>'suspended'
 AND (o.service_status<>'trial' OR o.trial_ends_at>now())
 AND (o.paid_subscription_expires_at IS NULL OR o.paid_subscription_expires_at>now()));
$$;
