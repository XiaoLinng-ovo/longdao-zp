-- Versioned platform billing policy and enterprise quota ledger.
CREATE TABLE public.billing_policy_versions (
 id bigserial PRIMARY KEY, config jsonb NOT NULL CHECK (jsonb_typeof(config)='object'),
 created_by uuid REFERENCES public.users(id), reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.billing_policy_versions(config,reason) VALUES (
 '{"enabled":false,"rules":{"resume_analysis":{"enabled":true,"resource":"ai_points","quantity":10,"unitSize":1},"job_spec":{"enabled":true,"resource":"ai_points","quantity":20,"unitSize":1},"jd":{"enabled":true,"resource":"ai_points","quantity":20,"unitSize":1},"interview_questions":{"enabled":true,"resource":"ai_points","quantity":30,"unitSize":1},"answer_analysis":{"enabled":true,"resource":"ai_points","quantity":5,"unitSize":1},"interview_summary":{"enabled":false,"resource":"ai_points","quantity":0,"unitSize":1},"transcript_processing":{"enabled":false,"resource":"ai_points","quantity":0,"unitSize":1},"interview_audio":{"enabled":true,"resource":"interview_seconds","quantity":1,"unitSize":1},"ocr":{"enabled":true,"resource":"ocr_pages","quantity":1,"unitSize":1}},"limits":{"maxConcurrent":2,"dailyAiPoints":20000,"maxInputChars":100000,"maxOutputTokens":8192},"trial":{"resumeUploads":3,"interviews":3,"aiGenerations":3}}',
 'Initial editable policy; charging disabled'
);
CREATE FUNCTION public.immutable_billing_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Billing versions are immutable; publish a new version'; END; $$;
CREATE TRIGGER immutable_billing_version BEFORE UPDATE OR DELETE ON public.billing_policy_versions
 FOR EACH ROW EXECUTE FUNCTION public.immutable_billing_version();
ALTER TABLE public.payment_products ADD COLUMN billing_kind text NOT NULL DEFAULT 'subscription' CHECK(billing_kind IN ('subscription','addon'));
ALTER TABLE public.payment_products ADD COLUMN billing_entitlements jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.payment_orders ADD COLUMN billing_kind text NOT NULL DEFAULT 'subscription';
ALTER TABLE public.payment_orders ADD COLUMN billing_entitlements jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE OR REPLACE FUNCTION public.immutable_payment_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.plan_version_id,NEW.name,NEW.amount_fen,NEW.currency,NEW.duration_days,NEW.duration_months,NEW.all_modules,NEW.billing_kind,NEW.billing_entitlements)
 IS DISTINCT FROM ROW(OLD.plan_version_id,OLD.name,OLD.amount_fen,OLD.currency,OLD.duration_days,OLD.duration_months,OLD.all_modules,OLD.billing_kind,OLD.billing_entitlements) THEN
 RAISE EXCEPTION 'Publish a new price version instead of changing a sold product'; END IF;
 RETURN NEW;
END; $$;
CREATE TABLE public.billing_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id),
 resource text NOT NULL CHECK(resource IN ('ai_points','interview_seconds','ocr_pages')),
 total bigint NOT NULL CHECK(total>0 AND total<=1000000000000), remaining bigint NOT NULL CHECK(remaining>=0 AND remaining<=total),
 valid_from timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL CHECK(expires_at>valid_from),
 order_id uuid REFERENCES public.payment_orders(id), source_key text NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,source_key,resource)
);
CREATE INDEX billing_grants_balance ON public.billing_grants(organization_id,resource,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE public.billing_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id),
 operation text NOT NULL, task_key text NOT NULL, fingerprint text NOT NULL,
 policy_version bigint NOT NULL REFERENCES public.billing_policy_versions(id), rule_snapshot jsonb NOT NULL,
 resource text NOT NULL, units bigint NOT NULL CHECK(units>=0),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','released','uncertain')),
 allocations jsonb NOT NULL DEFAULT '[]', result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, UNIQUE(organization_id,operation,task_key)
);
CREATE INDEX billing_tasks_org_time ON public.billing_tasks(organization_id,created_at DESC);
CREATE FUNCTION public.billing_trial_limit(kind text) RETURNS integer LANGUAGE sql STABLE AS $$
 SELECT (config->'trial'->>kind)::integer FROM public.billing_policy_versions ORDER BY id DESC LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION public.enforce_trial_resume_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_count integer;
BEGIN
 IF (SELECT service_status FROM public.organizations WHERE id=NEW.organization_id) IS DISTINCT FROM 'trial' THEN RETURN NEW; END IF;
 INSERT INTO public.organization_trial_usage(organization_id) VALUES(NEW.organization_id) ON CONFLICT DO NOTHING;
 UPDATE public.organization_trial_usage SET resume_uploads=resume_uploads+1,updated_at=now()
 WHERE organization_id=NEW.organization_id AND resume_uploads<public.billing_trial_limit('resumeUploads')
 RETURNING resume_uploads INTO next_count;
 IF next_count IS NULL THEN RAISE EXCEPTION 'TRIAL_RESUME_LIMIT_REACHED' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION public.enforce_trial_interview_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org uuid;
BEGIN
 SELECT i.organization_id INTO org FROM interviews i JOIN public.organizations o ON o.id=i.organization_id
 WHERE i.id=NEW.interview_id AND o.service_status='trial';
 IF org IS NULL THEN RETURN NEW; END IF;
 PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.organization_trial_interviews WHERE organization_id=org AND interview_id=NEW.interview_id) THEN RETURN NEW; END IF;
 IF (SELECT count(*) FROM public.organization_trial_interviews WHERE organization_id=org)>=public.billing_trial_limit('interviews')
 THEN RAISE EXCEPTION 'TRIAL_INTERVIEW_LIMIT_REACHED' USING ERRCODE='P0001'; END IF;
 INSERT INTO public.organization_trial_interviews(organization_id,interview_id) VALUES(org,NEW.interview_id);
 RETURN NEW;
END; $$;
