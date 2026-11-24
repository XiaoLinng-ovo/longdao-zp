-- Normalize historical Offer templates so reporting locations remain configurable.
-- Templates may live in public or in a company_* schema after tenant isolation.
DO $$
DECLARE
  template_schema record;
  location_prefix text := U&'\676d\5dde\5e02\4f59\676d\533a';
  location_brand text := '(' || U&'\57ce\6295\672a\6765\4e4b\661f' || '|' || U&'\672a\6765\79d1\6280\57ce' || ')';
  location_pattern text;
  location_variable text := U&'\62a5\5230\5730\70b9';
BEGIN
  location_pattern := location_prefix || location_brand
    || '[[:space:]]*C2[[:space:]]*' || U&'\5e62'
    || '([[:space:]]*21[[:space:]]*' || U&'\697c' || ')?[[:space:]]*2105[[:space:]]*'
    || U&'\5ba4';

  FOR template_schema IN
    SELECT n.nspname AS schema_name
    FROM pg_namespace n
    WHERE n.nspname = 'public'
       OR n.nspname ~ '^company_[0-9a-f]{32}$'
  LOOP
    IF to_regclass(format('%I.offer_templates', template_schema.schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'UPDATE %I.offer_templates
          SET content = regexp_replace(content, %L, %L, ''g'')
        WHERE content ~ %L',
      template_schema.schema_name, location_pattern, '{{' || location_variable || '}}', location_pattern
    );
  END LOOP;
END;
$$;
