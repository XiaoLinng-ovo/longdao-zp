-- Explicit platform operators are not inferred from enterprise memberships or business roles.
CREATE TABLE IF NOT EXISTS platform_operators (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'viewer')),
  is_active boolean NOT NULL DEFAULT true,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS service_status text NOT NULL DEFAULT 'enabled'
  CHECK (service_status IN ('enabled', 'trial', 'suspended'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS service_version integer NOT NULL DEFAULT 1;
ALTER TABLE organizations ADD CONSTRAINT organizations_trial_deadline_check
  CHECK (service_status <> 'trial' OR trial_ends_at IS NOT NULL);
-- Preserve every existing organization's status and business data. No implicit trial or operator grants.
CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  action text NOT NULL,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_audit_logs_created_idx ON platform_audit_logs(created_at DESC);
-- Shared policy for sessions, enterprise settings, invitations, and background task claims.
CREATE OR REPLACE FUNCTION organization_service_available(target_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM organizations o WHERE o.id = target_id AND o.status = 'active'
    AND o.service_status <> 'suspended'
    AND (o.service_status <> 'trial' OR o.trial_ends_at > now()));
$$;
