-- Preserve historical day-based orders; new offers use calendar months.
ALTER TABLE billing_sandbox_orders
 ALTER COLUMN duration_days DROP NOT NULL,
 ADD COLUMN duration_months integer CHECK (duration_months IN (1, 6, 12)),
 ADD COLUMN all_modules boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT billing_sandbox_orders_duration_check CHECK (
  (duration_days IS NOT NULL AND duration_months IS NULL) OR
  (duration_days IS NULL AND duration_months IS NOT NULL)
 );
