ALTER TABLE public.organization_members ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS ai_model_source text NOT NULL DEFAULT 'enterprise'
  CHECK (ai_model_source IN ('enterprise', 'platform'));

-- Preserve existing platform grants, but never grant access to a new enterprise.
UPDATE public.organizations SET ai_model_source='platform' WHERE use_platform_ai;

-- Existing self-service credentials previously took priority over a platform grant.
DO $$
DECLARE company record;
BEGIN
  UPDATE public.organizations o SET ai_model_source='enterprise'
  WHERE EXISTS (SELECT 1 FROM public.enterprise_ai_settings s WHERE s.organization_id=o.id
    AND s.self_service_enabled AND s.api_key_ciphertext IS NOT NULL AND length(trim(s.model))>0);
  FOR company IN SELECT organization_id,schema_name FROM public.organization_schemas
    WHERE status='ready' AND schema_name ~ '^company_[a-f0-9]{32}$'
  LOOP
    EXECUTE format('UPDATE public.organizations SET ai_model_source=''enterprise'' WHERE id=$1 AND EXISTS (SELECT 1 FROM %I.enterprise_ai_settings WHERE organization_id=$1 AND self_service_enabled AND api_key_ciphertext IS NOT NULL AND length(trim(model))>0)', company.schema_name)
      USING company.organization_id;
  END LOOP;
END $$;

-- Preserve compatible administrators while making the chief owner unambiguous.
WITH ranked AS (
  SELECT m.organization_id,m.user_id,row_number() OVER (
    PARTITION BY m.organization_id ORDER BY (m.user_id=o.created_by) DESC,m.joined_at,m.user_id
  ) AS position
  FROM public.organization_members m JOIN public.organizations o ON o.id=m.organization_id
  WHERE m.role='owner'
)
UPDATE public.organization_members m SET role='admin' FROM ranked r
WHERE m.organization_id=r.organization_id AND m.user_id=r.user_id AND r.position>1;
WITH candidates AS (
  SELECT DISTINCT ON (m.organization_id) m.organization_id,m.user_id
  FROM public.organization_members m JOIN public.organizations o ON o.id=m.organization_id
  JOIN public.users u ON u.id=m.user_id AND u.is_active
  WHERE m.is_active AND (m.role='admin' OR m.user_id=o.created_by)
    AND NOT EXISTS (SELECT 1 FROM public.organization_members owner WHERE owner.organization_id=m.organization_id AND owner.role='owner')
  ORDER BY m.organization_id,(m.user_id=o.created_by) DESC,m.joined_at,m.user_id
)
UPDATE public.organization_members m SET role='owner' FROM candidates c
WHERE m.organization_id=c.organization_id AND m.user_id=c.user_id;
CREATE UNIQUE INDEX IF NOT EXISTS organization_members_single_owner
  ON public.organization_members(organization_id) WHERE role='owner';

-- Retain historical counters and triggers without enforcing the retired three-use limits.
CREATE OR REPLACE FUNCTION public.enforce_trial_resume_quota() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION public.enforce_trial_interview_quota() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;

