-- The approval channel is an enterprise-wide choice for new recruitment requests.
-- Existing workspaces (including the legacy quarantine) default to platform approval.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS recruitment_approval_mode text NOT NULL DEFAULT 'platform';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_recruitment_approval_mode_check'
      AND conrelid = 'organizations'::regclass
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_recruitment_approval_mode_check
      CHECK (recruitment_approval_mode IN ('platform', 'dingtalk'));
  END IF;
END $$;
