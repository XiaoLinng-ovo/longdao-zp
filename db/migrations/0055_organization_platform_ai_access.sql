ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS use_platform_ai boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS platform_ai_source_organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL;
