CREATE TABLE IF NOT EXISTS external_event_receipts (
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  result jsonb,
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE IF NOT EXISTS external_entity_mappings (
  provider text NOT NULL,
  external_type text NOT NULL,
  external_id text NOT NULL,
  internal_type text NOT NULL,
  internal_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, external_type, external_id)
);

CREATE INDEX IF NOT EXISTS external_entity_internal_idx
  ON external_entity_mappings(internal_type, internal_id);
