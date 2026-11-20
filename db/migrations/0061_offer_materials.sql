ALTER TABLE offer_versions
  ADD COLUMN IF NOT EXISTS materials jsonb NOT NULL DEFAULT '[]'::jsonb;
