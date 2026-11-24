ALTER TABLE public.object_cleanup_tasks
  ADD COLUMN storage_kind text NOT NULL DEFAULT 'resume' CHECK (storage_kind IN ('resume','interview')),
  ADD COLUMN lease_token uuid,
  ADD COLUMN last_error text;
ALTER TABLE public.object_cleanup_tasks DROP CONSTRAINT object_cleanup_tasks_status_check;
ALTER TABLE public.object_cleanup_tasks ADD CONSTRAINT object_cleanup_tasks_status_check CHECK (status IN ('pending','completed','failed'));

-- Shared bookkeeping only; all reads/writes still use the authenticated company schema.
CREATE TABLE public.interview_stored_objects (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  session_id uuid NOT NULL,
  storage_key text NOT NULL,
  schema_name text NOT NULL CHECK (schema_name='public' OR schema_name ~ '^company_[0-9a-f]{32}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,storage_key)
);
CREATE INDEX interview_stored_objects_session ON public.interview_stored_objects(organization_id,session_id);
