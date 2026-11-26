-- 0113 remains installed if this guard fails, so audited offboarding can resolve conflicts.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.organization_members WHERE ended_at IS NULL GROUP BY user_id HAVING count(*)>1) THEN
  RAISE EXCEPTION 'MULTIPLE_ENTERPRISE_BINDINGS: run scripts/audit-single-enterprise.mjs; use an explicit offboarding resolution plan before retrying';
 END IF;
END $$;
CREATE UNIQUE INDEX organization_members_single_binding ON public.organization_members(user_id) WHERE ended_at IS NULL;
