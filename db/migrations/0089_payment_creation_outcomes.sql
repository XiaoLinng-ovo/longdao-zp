ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS creation_outcome text NOT NULL DEFAULT 'unknown'
    CHECK (creation_outcome IN ('unknown', 'created', 'not_created')),
  ADD COLUMN IF NOT EXISTS creation_error_code text,
  ADD COLUMN IF NOT EXISTS channel_close_pending boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS payment_orders_local_cancel_check_idx
  ON public.payment_orders (last_checked_at NULLS FIRST)
  WHERE channel_close_pending AND status = 'cancelled';
