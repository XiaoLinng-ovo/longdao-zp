-- Keep invoice details with each Offer version, including existing tenant schemas.
DO $$
DECLARE
  target_schema record;
BEGIN
  FOR target_schema IN
    SELECT nspname FROM pg_namespace
    WHERE nspname = 'public' OR nspname ~ '^company_[0-9a-f]{32}$'
  LOOP
    IF to_regclass(format('%I.offer_versions', target_schema.nspname)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.offer_versions ADD COLUMN IF NOT EXISTS invoice_title text, ADD COLUMN IF NOT EXISTS tax_number text',
        target_schema.nspname
      );
    END IF;
  END LOOP;
END;
$$;
