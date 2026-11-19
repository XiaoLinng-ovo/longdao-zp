ALTER TABLE platform_operators DROP CONSTRAINT IF EXISTS platform_operators_role_check;
ALTER TABLE platform_operators
  ADD CONSTRAINT platform_operators_role_check
  CHECK (role IN ('admin', 'viewer'));

CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_events_created_idx ON workflow_events(created_at DESC);
CREATE INDEX IF NOT EXISTS login_attempts_created_idx ON login_attempts(attempted_at DESC);
CREATE INDEX IF NOT EXISTS sessions_created_idx ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_logs_actor_idx
  ON platform_audit_logs(actor_user_id, created_at DESC);
