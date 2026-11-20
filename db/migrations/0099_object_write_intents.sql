CREATE TABLE public.object_write_intents (
  attempt_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  schema_name text NOT NULL CHECK (schema_name='public' OR schema_name='company_' || replace(organization_id::text,'-','')),
  storage_kind text NOT NULL CHECK (storage_kind IN ('resume','interview')),
  parent_id uuid NOT NULL,
  logical_key text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  location_id text CHECK (location_id IS NULL OR location_id ~ '^[0-9a-f]{64}$'),
  content_version text NOT NULL,
  status text NOT NULL DEFAULT 'writing' CHECK (status IN ('writing','unknown','bound','cleanup_pending','deleting','deleted')),
  lease_until timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX object_write_expiration ON public.object_write_intents(lease_until,attempt_id) WHERE status='writing';
ALTER TABLE public.interview_stored_objects ADD COLUMN physical_key text;
CREATE UNIQUE INDEX interview_stored_physical_key ON public.interview_stored_objects(physical_key) WHERE physical_key IS NOT NULL;
