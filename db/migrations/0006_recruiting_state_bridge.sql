-- Transitional PostgreSQL state bridge for the local business service.
-- It provides real PostgreSQL transactions while the normalized repositories
-- are migrated incrementally. It is not a replacement for the domain tables.
CREATE TABLE IF NOT EXISTS recruiting_state (
  id text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
