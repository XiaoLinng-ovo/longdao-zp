-- Repair installations that applied the historical three-role constraint.
-- Do not silently promote or remove an operator if unsupported rows remain.
DO $$
DECLARE
  actual text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO actual
    FROM pg_constraint
   WHERE conrelid = 'public.platform_operators'::regclass
     AND conname = 'platform_operators_role_check' AND contype = 'c' AND convalidated;
  IF actual = 'CHECK ((role = ANY (ARRAY[''admin''::text, ''viewer''::text])))' THEN
    RETURN;
  END IF;
  IF actual IS DISTINCT FROM 'CHECK ((role = ANY (ARRAY[''super_admin''::text, ''admin''::text, ''viewer''::text])))' THEN
    RAISE EXCEPTION 'Unexpected platform operator role constraint; manual review required';
  END IF;
  ALTER TABLE public.platform_operators
    DROP CONSTRAINT platform_operators_role_check,
    ADD CONSTRAINT platform_operators_role_check CHECK (role IN ('admin', 'viewer'));
END;
$$;
