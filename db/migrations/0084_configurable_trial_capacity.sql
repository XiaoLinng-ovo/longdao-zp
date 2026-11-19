-- New enterprises snapshot the platform trial duration and capacity; existing rights remain unchanged.
INSERT INTO public.billing_policy_versions(config,reason)
SELECT jsonb_set(config,'{trial}',config->'trial'||'{"durationDays":14,"seatLimit":5,"jobLimit":20}'::jsonb),'Add editable trial duration and initial capacity'
FROM public.billing_policy_versions ORDER BY id DESC LIMIT 1;
CREATE FUNCTION public.configure_new_trial_organization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy_id bigint; trial_config jsonb; trial_plan uuid;
BEGIN
 IF NEW.service_status<>'trial' THEN RETURN NEW; END IF;
 SELECT id,config->'trial' INTO policy_id,trial_config FROM public.billing_policy_versions ORDER BY id DESC LIMIT 1;
 IF NEW.trial_ends_at IS NULL THEN NEW.trial_ends_at=now()+make_interval(days=>(trial_config->>'durationDays')::integer); END IF;
 IF NEW.plan_version_id='00000000-0000-4000-8000-000000000052'::uuid THEN
  INSERT INTO public.subscription_plan_versions(code,version,name,seat_limit,job_limit)
  VALUES('configured_trial',policy_id::integer,'平台配置试用版',(trial_config->>'seatLimit')::integer,(trial_config->>'jobLimit')::integer)
  ON CONFLICT(code,version) DO NOTHING;
  SELECT id INTO trial_plan FROM public.subscription_plan_versions WHERE code='configured_trial' AND version=policy_id::integer;
  NEW.plan_version_id=trial_plan;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER configure_new_trial_organization BEFORE INSERT ON public.organizations
 FOR EACH ROW EXECUTE FUNCTION public.configure_new_trial_organization();
