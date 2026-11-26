-- Versioned manual template values; does not enable organization-schema isolation.
DO $$
DECLARE target_schema record;
BEGIN
  FOR target_schema IN
    SELECT nspname FROM pg_namespace
    WHERE nspname = 'public' OR nspname ~ '^company_[0-9a-f]{32}$'
  LOOP
    IF to_regclass(format('%I.offer_versions', target_schema.nspname)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.offer_versions ADD COLUMN IF NOT EXISTS template_fields jsonb NOT NULL DEFAULT ''{}''::jsonb', target_schema.nspname);
    END IF;
  END LOOP;
END;
$$;
