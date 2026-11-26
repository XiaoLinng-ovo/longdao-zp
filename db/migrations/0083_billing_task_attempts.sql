-- Preserve each failed attempt while allowing the same logical request to retry safely.
ALTER TABLE public.billing_tasks ADD COLUMN request_key text, ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK(attempt>0);
UPDATE public.billing_tasks SET request_key=task_key;
ALTER TABLE public.billing_tasks ALTER COLUMN request_key SET NOT NULL;
CREATE UNIQUE INDEX billing_tasks_request_attempt ON public.billing_tasks(organization_id,operation,request_key,attempt);
CREATE INDEX billing_tasks_active ON public.billing_tasks(organization_id) WHERE state IN ('reserved','uncertain');
