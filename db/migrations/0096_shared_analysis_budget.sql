CREATE TABLE public.analysis_execution_leases (
  schema_name text NOT NULL CHECK (schema_name='public' OR schema_name ~ '^company_[0-9a-f]{32}$'),
  task_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  attempt integer NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (schema_name,task_id)
);
CREATE INDEX analysis_execution_active ON public.analysis_execution_leases(expires_at,organization_id);
CREATE TABLE public.analysis_dispatch_states (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),
  schema_name text NOT NULL,
  waiting_until timestamptz NOT NULL,
  last_claimed_at timestamptz
);
