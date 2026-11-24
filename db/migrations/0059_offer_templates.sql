CREATE TABLE IF NOT EXISTS offer_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  filename text NOT NULL,
  content text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(name) BETWEEN 1 AND 200),
  CHECK (filename ~* '[.]md$'),
  CHECK (char_length(content) <= 50000)
);

CREATE INDEX IF NOT EXISTS offer_templates_organization_updated_idx
  ON offer_templates (organization_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS offer_templates_one_active_default_per_organization
  ON offer_templates (organization_id)
  WHERE is_active AND is_default;

DROP TRIGGER IF EXISTS offer_templates_set_updated_at ON offer_templates;
CREATE TRIGGER offer_templates_set_updated_at
  BEFORE UPDATE ON offer_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
