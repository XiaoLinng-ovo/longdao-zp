ALTER TABLE email_verification_challenges
  ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN delivered_at timestamptz,
  DROP CONSTRAINT email_verification_challenges_purpose_check,
  ADD CONSTRAINT email_verification_challenges_purpose_check CHECK (
    (purpose IN ('registration', 'password_reset') AND user_id IS NULL) OR
    (purpose = 'email_change' AND user_id IS NOT NULL)
  );

CREATE INDEX email_verification_challenges_user_idx
  ON email_verification_challenges(user_id, created_at DESC) WHERE purpose = 'email_change';
