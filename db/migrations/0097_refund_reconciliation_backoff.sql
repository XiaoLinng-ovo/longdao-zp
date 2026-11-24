ALTER TABLE public.payment_orders
  ADD COLUMN refund_check_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN refund_next_check_at timestamptz,
  ADD COLUMN refund_check_error text;
CREATE INDEX payment_refund_next_check ON public.payment_orders(refund_next_check_at,id) WHERE status='refund_pending';
