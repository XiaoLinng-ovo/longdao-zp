-- Existing schemas created by 0112 must match schemas created by the initializer.
DO $$
DECLARE company record;
BEGIN
 FOR company IN SELECT organization_id,schema_name FROM public.organization_schemas ORDER BY organization_id LOOP
  IF company.schema_name <> 'company_' || replace(company.organization_id::text,'-','') THEN
   RAISE EXCEPTION 'INVALID_ORGANIZATION_SCHEMA_NAME';
  END IF;
  EXECUTE format('ALTER TABLE %I.interview_summary_versions ALTER COLUMN organization_id SET DEFAULT %L::uuid',company.schema_name,company.organization_id);
  EXECUTE format('ALTER TABLE %I.interview_summary_versions ADD CONSTRAINT interview_summary_versions_organization_scope CHECK (organization_id = %L::uuid)',company.schema_name,company.organization_id);
 END LOOP;
END;
$$;
