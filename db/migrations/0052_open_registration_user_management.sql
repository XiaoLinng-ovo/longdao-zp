-- Open registration and platform user directory support.
-- Keep local migrations 0050/0051 intact when integrating upstream features.
-- Existing users remain legacy accounts; no role or enterprise data is rewritten.

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_source text;

UPDATE users
SET registration_source = 'legacy'
WHERE registration_source IS NULL;

ALTER TABLE users ALTER COLUMN registration_source SET DEFAULT 'legacy';
ALTER TABLE users ALTER COLUMN registration_source SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_registration_source_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_registration_source_check
      CHECK (registration_source IN ('legacy', 'open_registration', 'platform_created'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS registration_attempts (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  ip_address inet,
  succeeded boolean NOT NULL DEFAULT false,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registration_attempts_email_time_idx
  ON registration_attempts(lower(email), attempted_at DESC);
CREATE INDEX IF NOT EXISTS registration_attempts_ip_time_idx
  ON registration_attempts(ip_address, attempted_at DESC);
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS users_active_created_idx ON users(is_active, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_user_last_seen_idx
  ON sessions(user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;
