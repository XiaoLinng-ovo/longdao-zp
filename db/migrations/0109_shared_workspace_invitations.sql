-- Legacy single-recipient grants must never become reusable grants.
UPDATE organization_invitations SET revoked_at=now()
 WHERE revoked_at IS NULL AND accepted_at IS NULL;
ALTER TABLE organization_invitations ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS organization_invitation_joins (
  invitation_id uuid NOT NULL REFERENCES organization_invitations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invitation_id,user_id)
);
CREATE INDEX IF NOT EXISTS organization_invitation_joins_user_idx ON organization_invitation_joins(user_id);
ALTER TABLE organization_invitations ADD CONSTRAINT shared_invitation_defaults CHECK (
  NOT is_shared OR (email IS NULL AND membership_role='member' AND business_role='recruiter'
    AND department_id IS NULL AND accepted_at IS NULL AND accepted_by IS NULL
    AND expires_at=created_at+interval '72 hours')
);
