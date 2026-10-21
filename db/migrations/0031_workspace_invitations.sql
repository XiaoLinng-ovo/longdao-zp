-- Invitations are one-use enterprise membership grants, never login credentials.
ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS business_role text
  CHECK (business_role IN ('recruiter', 'hiring_manager', 'approver', 'interviewer'));
ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS organization_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  email text,
  membership_role text NOT NULL DEFAULT 'member' CHECK (membership_role IN ('member','admin')),
  business_role text NOT NULL CHECK (business_role IN ('recruiter','hiring_manager','approver','interviewer')),
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS organization_invitations_org_idx ON organization_invitations(organization_id, created_at DESC);
