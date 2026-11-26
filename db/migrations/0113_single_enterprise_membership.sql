-- Disabled memberships still bind an account. Only an explicit departure releases it.
ALTER TABLE public.organization_members ADD COLUMN ended_at timestamptz;
ALTER TABLE public.organization_members ADD CONSTRAINT ended_membership_inactive CHECK (ended_at IS NULL OR (NOT is_active AND role<>'owner'));
CREATE TABLE public.organization_membership_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id),
 user_id uuid NOT NULL REFERENCES public.users(id),
 role text NOT NULL, joined_at timestamptz NOT NULL, ended_at timestamptz NOT NULL,
 actor_user_id uuid REFERENCES public.users(id), reason text NOT NULL
);
CREATE TABLE public.organization_exit_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id),
 user_id uuid NOT NULL REFERENCES public.users(id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 2 AND 500),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 resolved_by uuid REFERENCES public.users(id), resolution text
);
CREATE UNIQUE INDEX organization_exit_request_pending ON public.organization_exit_requests(organization_id,user_id) WHERE status='pending';
CREATE FUNCTION public.invalidate_membership_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(OLD.is_active,OLD.role,OLD.department_id,OLD.ended_at) IS DISTINCT FROM ROW(NEW.is_active,NEW.role,NEW.department_id,NEW.ended_at) THEN
  UPDATE public.sessions SET revoked_at=now() WHERE user_id=NEW.user_id AND revoked_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_sessions AFTER UPDATE ON public.organization_members FOR EACH ROW EXECUTE FUNCTION public.invalidate_membership_sessions();
-- Count current bindings, including disabled members, but not historical departures.
CREATE OR REPLACE FUNCTION public.maintain_organization_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id uuid; target_id uuid; seats integer; jobs_count integer; seat_cap integer; job_cap integer;
BEGIN
 IF TG_OP<>'INSERT' THEN source_id=OLD.organization_id; END IF;
 IF TG_OP<>'DELETE' THEN target_id=NEW.organization_id; END IF;
 IF TG_TABLE_NAME='organization_members' THEN
  IF TG_OP<>'INSERT' AND OLD.ended_at IS NOT NULL THEN source_id=NULL; END IF;
  IF TG_OP<>'DELETE' AND NEW.ended_at IS NOT NULL THEN target_id=NULL; END IF;
 END IF;
 IF source_id IS NOT DISTINCT FROM target_id THEN RETURN NULL; END IF;
 PERFORM id FROM public.organizations WHERE id IN(source_id,target_id) ORDER BY id FOR NO KEY UPDATE;
 IF source_id IS NOT NULL THEN
  IF TG_TABLE_NAME='organization_members' THEN UPDATE public.organizations SET seat_usage=seat_usage-1 WHERE id=source_id;
  ELSE UPDATE public.organizations SET job_usage=job_usage-1 WHERE id=source_id; END IF;
 END IF;
 IF target_id IS NOT NULL THEN
  SELECT o.seat_usage,o.job_usage,p.seat_limit,p.job_limit INTO seats,jobs_count,seat_cap,job_cap FROM public.organizations o JOIN public.subscription_plan_versions p ON p.id=o.plan_version_id WHERE o.id=target_id;
  IF TG_TABLE_NAME='organization_members' THEN
   IF seat_cap IS NOT NULL AND seats>=seat_cap THEN RAISE EXCEPTION 'SEAT_LIMIT_EXCEEDED' USING ERRCODE='P5501'; END IF;
   UPDATE public.organizations SET seat_usage=seat_usage+1 WHERE id=target_id;
  ELSE
   IF job_cap IS NOT NULL AND jobs_count>=job_cap THEN RAISE EXCEPTION 'JOB_LIMIT_EXCEEDED' USING ERRCODE='P5502'; END IF;
   UPDATE public.organizations SET job_usage=job_usage+1 WHERE id=target_id;
  END IF;
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER organization_member_capacity ON public.organization_members;
CREATE TRIGGER organization_member_capacity AFTER INSERT OR DELETE OR UPDATE OF organization_id,ended_at ON public.organization_members FOR EACH ROW EXECUTE FUNCTION public.maintain_organization_capacity();
