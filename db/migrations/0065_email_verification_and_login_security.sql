-- Email verification, persistent authentication throttling, password reset,
-- administrator MFA, and Turnstile-compatible security challenges.
-- This intentionally follows 0064_onboarding_workbench.sql.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS email_verification_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL CHECK (purpose IN ('registration', 'password_reset')),
  email text NOT NULL,
  code_hash text NOT NULL CHECK (length(code_hash) = 64),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  consumed_at timestamptz,
  invalidated_at timestamptz,
  request_ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_verification_challenges_lookup_idx
  ON email_verification_challenges(purpose, lower(email), created_at DESC);
CREATE INDEX IF NOT EXISTS email_verification_challenges_ip_idx
  ON email_verification_challenges(request_ip, created_at DESC)
  WHERE request_ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_verification_challenges_expiry_idx
  ON email_verification_challenges(expires_at);

ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS failure_reason text;
CREATE INDEX IF NOT EXISTS login_attempts_failed_email_time_idx
  ON login_attempts(lower(email), attempted_at DESC)
  WHERE succeeded = false;
CREATE INDEX IF NOT EXISTS login_attempts_failed_ip_time_idx
  ON login_attempts(ip_address, attempted_at DESC)
  WHERE succeeded = false AND ip_address IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_mfa_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted text NOT NULL,
  recovery_code_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_used_step bigint,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mfa_login_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login_attempt_id bigint REFERENCES login_attempts(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('login', 'setup')),
  encrypted_secret text,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  consumed_at timestamptz,
  invalidated_at timestamptz,
  request_ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'login' OR encrypted_secret IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS mfa_login_challenges_user_idx
  ON mfa_login_challenges(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mfa_login_challenges_expiry_idx
  ON mfa_login_challenges(expires_at);

COMMENT ON TABLE email_verification_challenges IS
  'HMAC-only, short-lived registration and password reset codes. Plaintext codes are never persisted.';
COMMENT ON TABLE login_attempts IS
  'Persistent login throttling and audit events shared across API instances.';
COMMENT ON TABLE user_mfa_credentials IS
  'Administrator TOTP secrets encrypted with AES-256-GCM and hashed one-time recovery codes.';
