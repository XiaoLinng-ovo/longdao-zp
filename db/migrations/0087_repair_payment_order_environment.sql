-- Repair installations whose 0086 ledger entry exists but the order column is missing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment_orders'
      AND column_name = 'environment'
  ) THEN
    ALTER TABLE public.payment_orders
      ADD COLUMN environment text NOT NULL DEFAULT 'production'
      CHECK (environment IN ('production', 'sandbox'));

    -- Recover the best available environment for orders created before the repair.
    UPDATE public.payment_orders AS orders
    SET environment = providers.environment
    FROM public.payment_providers AS providers
    WHERE orders.provider_id = providers.id
      AND orders.environment IS DISTINCT FROM providers.environment;
  END IF;
END;
$$;
