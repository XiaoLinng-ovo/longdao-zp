-- Existing enterprise credentials remain inactive until explicitly saved by a member.
ALTER TABLE enterprise_ai_settings
  ADD COLUMN self_service_enabled boolean NOT NULL DEFAULT false;

DO $$
DECLARE target_schema record;
BEGIN
  FOR target_schema IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^company_[0-9a-f]{32}$'
  LOOP
    IF to_regclass(format('%I.enterprise_ai_settings', target_schema.nspname)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.enterprise_ai_settings ADD COLUMN self_service_enabled boolean NOT NULL DEFAULT false', target_schema.nspname);
    END IF;
  END LOOP;
END;
$$;
