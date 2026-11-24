-- Authentication hardening: persistent CSRF tokens and login throttling.
-- Safe to apply after 0001 on existing installations; all alterations are additive.

CREATE TABLE IF NOT EXISTS csrf_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS csrf_tokens_session_idx ON csrf_tokens(session_id);
CREATE INDEX IF NOT EXISTS csrf_tokens_expiry_idx ON csrf_tokens(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  ip_address inet,
  succeeded boolean NOT NULL DEFAULT false,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_attempts_email_time_idx
  ON login_attempts(lower(email), attempted_at DESC);
CREATE INDEX IF NOT EXISTS login_attempts_ip_time_idx
  ON login_attempts(ip_address, attempted_at DESC);

-- Keep session lifecycle explicit for database-backed cleanup and revocation.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_address inet;

CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_revoked_idx ON sessions(revoked_at)
  WHERE revoked_at IS NOT NULL;

COMMENT ON TABLE csrf_tokens IS 'Rotating CSRF token hashes associated with database sessions';
COMMENT ON TABLE login_attempts IS 'Authentication audit/throttling events; retain according to security policy';
