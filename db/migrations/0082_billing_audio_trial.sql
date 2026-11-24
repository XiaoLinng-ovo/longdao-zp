-- Audio accounting and first-use trial resource grants; append a new policy, never rewrite history.
CREATE TABLE public.billing_trial_grants (
 organization_id uuid NOT NULL REFERENCES public.organizations(id), resource text NOT NULL,
 policy_version bigint NOT NULL REFERENCES public.billing_policy_versions(id), PRIMARY KEY(organization_id,resource)
);
CREATE TABLE public.billing_audio_sessions (
 session_id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id),
 policy_version bigint NOT NULL REFERENCES public.billing_policy_versions(id), config_snapshot jsonb NOT NULL
);
ALTER TABLE public.billing_tasks ADD COLUMN audio_session_id uuid, ADD COLUMN audio_start_ms bigint, ADD COLUMN audio_end_ms bigint;
CREATE INDEX billing_tasks_audio ON public.billing_tasks(organization_id,audio_session_id) WHERE audio_session_id IS NOT NULL;
CREATE TABLE public.billing_stream_sources (
 organization_id uuid NOT NULL REFERENCES public.organizations(id), session_id uuid NOT NULL, source text NOT NULL,
 connection_id uuid NOT NULL, lease_until timestamptz NOT NULL, end_ms bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(organization_id,session_id,source)
);

INSERT INTO public.billing_policy_versions(config,reason)
SELECT jsonb_set(config,'{trial}',jsonb_build_object('aiPoints',100,'interviewSeconds',5400,'ocrPages',30)||(config->'trial')),
 '增加可配置的首次试用算力额度，保留原计费开关和扣费规则'
FROM public.billing_policy_versions ORDER BY id DESC LIMIT 1;
