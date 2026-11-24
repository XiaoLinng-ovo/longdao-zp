-- Internal contact channel remains available to active members after subscription expiry.
CREATE TABLE public.enterprise_service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  message text NOT NULL CHECK (char_length(message) BETWEEN 2 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  response text CHECK (char_length(response) BETWEEN 2 AND 2000),
  resolved_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((status='open' AND response IS NULL AND resolved_at IS NULL)
    OR (status='resolved' AND response IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX enterprise_service_request_open_idx
  ON public.enterprise_service_requests(organization_id) WHERE status='open';
CREATE INDEX enterprise_service_request_created_idx
  ON public.enterprise_service_requests(created_at DESC);
