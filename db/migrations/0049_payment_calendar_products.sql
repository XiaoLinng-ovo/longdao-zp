-- Keep existing day-based products and order snapshots unchanged.
ALTER TABLE payment_products
 ALTER COLUMN duration_days DROP NOT NULL,
 ADD COLUMN duration_months integer CHECK (duration_months BETWEEN 1 AND 120),
 ADD COLUMN all_modules boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT payment_products_duration_check CHECK (
  (duration_days IS NOT NULL AND duration_months IS NULL) OR
  (duration_days IS NULL AND duration_months IS NOT NULL)
 );
ALTER TABLE payment_orders
 ALTER COLUMN duration_days DROP NOT NULL,
 ADD COLUMN duration_months integer CHECK (duration_months BETWEEN 1 AND 120),
 ADD COLUMN all_modules boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT payment_orders_duration_check CHECK (
  (duration_days IS NOT NULL AND duration_months IS NULL) OR
  (duration_days IS NULL AND duration_months IS NOT NULL)
 );
CREATE OR REPLACE FUNCTION immutable_payment_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.plan_version_id,NEW.name,NEW.amount_fen,NEW.currency,NEW.duration_days,NEW.duration_months,NEW.all_modules) IS DISTINCT FROM
    ROW(OLD.plan_version_id,OLD.name,OLD.amount_fen,OLD.currency,OLD.duration_days,OLD.duration_months,OLD.all_modules) THEN
   RAISE EXCEPTION 'Publish a new price version instead of changing a sold product';
 END IF;
 RETURN NEW;
END; $$;
