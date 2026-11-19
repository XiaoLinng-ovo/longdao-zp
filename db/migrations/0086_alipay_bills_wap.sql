ALTER TABLE public.payment_providers ADD COLUMN environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('production','sandbox'));
ALTER TABLE public.payment_orders ADD COLUMN environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('production','sandbox'));
ALTER TABLE public.payment_orders DROP CONSTRAINT payment_orders_mode_check;
ALTER TABLE public.payment_orders ADD CONSTRAINT payment_orders_mode_check CHECK (mode IN ('qrcode','redirect','wap'));
CREATE TABLE public.payment_bill_runs (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES public.payment_providers(id),
  bill_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','differences','not_ready','failed')),
  attempts integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  file_sha256 text,
  entry_count integer NOT NULL DEFAULT 0,
  difference_count integer NOT NULL DEFAULT 0,
  differences jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text,
  UNIQUE(provider_id,bill_date)
);
CREATE INDEX payment_bill_runs_retry_idx ON public.payment_bill_runs(next_retry_at) WHERE status IN ('failed','not_ready','running');
CREATE INDEX payment_orders_paid_bill_idx ON public.payment_orders(provider_id,paid_at) WHERE paid_at IS NOT NULL;
CREATE INDEX payment_orders_refund_bill_idx ON public.payment_orders(provider_id,refunded_at) WHERE refunded_at IS NOT NULL;
