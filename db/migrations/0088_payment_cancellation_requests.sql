ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_error_code text;

CREATE INDEX IF NOT EXISTS payment_orders_cancel_requested_idx
  ON public.payment_orders (last_checked_at NULLS FIRST)
  WHERE cancel_requested_at IS NOT NULL AND status IN ('pending', 'uncertain');
