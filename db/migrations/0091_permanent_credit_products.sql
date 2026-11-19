-- Product duration is separate from the payment deadline. No historical grants change.
ALTER TABLE public.payment_products DROP CONSTRAINT payment_products_duration_check;
ALTER TABLE public.payment_orders DROP CONSTRAINT payment_orders_duration_check;
ALTER TABLE public.payment_products ADD CONSTRAINT payment_products_duration_check CHECK (
 (duration_days IS NOT NULL AND duration_months IS NULL) OR
 (duration_months IS NOT NULL AND duration_days IS NULL) OR
 (billing_kind='addon' AND duration_days IS NULL AND duration_months IS NULL));
ALTER TABLE public.payment_orders ADD CONSTRAINT payment_orders_duration_check CHECK (
 (duration_days IS NOT NULL AND duration_months IS NULL) OR
 (duration_months IS NOT NULL AND duration_days IS NULL) OR
 (billing_kind='addon' AND duration_days IS NULL AND duration_months IS NULL));
ALTER TABLE public.billing_grants ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE public.payment_products ADD COLUMN description text NOT NULL DEFAULT '' CHECK(length(description)<=500);
ALTER TABLE public.payment_products ADD COLUMN sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 1000000);
ALTER TABLE public.payment_orders ADD COLUMN product_description text NOT NULL DEFAULT '';
CREATE OR REPLACE FUNCTION public.immutable_payment_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.plan_version_id,NEW.name,NEW.amount_fen,NEW.currency,NEW.duration_days,NEW.duration_months,NEW.all_modules,NEW.billing_kind,NEW.billing_entitlements,NEW.description,NEW.sort_order)
 IS DISTINCT FROM ROW(OLD.plan_version_id,OLD.name,OLD.amount_fen,OLD.currency,OLD.duration_days,OLD.duration_months,OLD.all_modules,OLD.billing_kind,OLD.billing_entitlements,OLD.description,OLD.sort_order) THEN
 RAISE EXCEPTION 'Publish a new price version instead of changing a sold product'; END IF;
 RETURN NEW;
END; $$;
CREATE TABLE public.billing_grant_conversions (
 grant_id uuid PRIMARY KEY REFERENCES public.billing_grants(id),
 order_id uuid NOT NULL REFERENCES public.payment_orders(id),
 previous_expires_at timestamptz NOT NULL, remaining_at_conversion bigint NOT NULL,
 converted_by uuid NOT NULL REFERENCES public.users(id), reason text NOT NULL,
 converted_at timestamptz NOT NULL DEFAULT now()
);
