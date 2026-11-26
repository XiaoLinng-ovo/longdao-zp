-- Inference provenance is separate from human confirmation and acoustic identity.
DO $$
DECLARE target_schema record;
BEGIN
  FOR target_schema IN
    SELECT nspname FROM pg_namespace
    WHERE nspname = 'public' OR nspname ~ '^company_[0-9a-f]{32}$'
  LOOP
    IF to_regclass(format('%I.interview_live_segments', target_schema.nspname)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.interview_live_segments ADD COLUMN IF NOT EXISTS role_review jsonb', target_schema.nspname);
    END IF;
  END LOOP;
END;
$$;
