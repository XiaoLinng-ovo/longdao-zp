-- Control data stays global; every access is scoped by organization and recipient.
CREATE TABLE public.recruitment_user_tasks (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  task_key text NOT NULL,
  fingerprint text NOT NULL,
  payload jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id, task_key)
);
CREATE TABLE public.recruitment_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  task_key text NOT NULL,
  event_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('assignment','schedule','removed','todo','reminder')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  path text,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','resolved','cancelled')),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, event_key)
);
CREATE INDEX recruitment_notifications_inbox_idx ON public.recruitment_notifications (organization_id,user_id,created_at DESC);
CREATE INDEX recruitment_notifications_unread_idx ON public.recruitment_notifications (organization_id,user_id) WHERE read_at IS NULL;

-- Assignment changes are persisted atomically with interviews, including changes made outside HTTP.
CREATE FUNCTION public.notify_interview_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_people jsonb := '[]'::jsonb;
  new_people jsonb := '[]'::jsonb;
  recipient uuid;
  previous boolean;
  current_person boolean;
  key text;
  event text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(OLD.participants, OLD.scheduled_start_at, OLD.location, OLD.meeting_url, OLD.status)
      IS NOT DISTINCT FROM ROW(NEW.participants, NEW.scheduled_start_at, NEW.location, NEW.meeting_url, NEW.status) THEN RETURN NEW; END IF;
    old_people := COALESCE(OLD.participants, '[]'::jsonb);
  END IF;
  new_people := COALESCE(NEW.participants, '[]'::jsonb);
  key := 'complete-' || NEW.id::text;
  FOR recipient IN
    SELECT DISTINCT (person->>'userId')::uuid FROM (
      SELECT value AS person FROM jsonb_array_elements(old_people)
      UNION ALL SELECT value FROM jsonb_array_elements(new_people)
    ) p WHERE COALESCE(person->>'role','interviewer')='interviewer'
      AND person->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  LOOP
    SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(old_people) p WHERE p->>'userId'=recipient::text AND COALESCE(p->>'role','interviewer')='interviewer') INTO previous;
    SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(new_people) p WHERE p->>'userId'=recipient::text AND COALESCE(p->>'role','interviewer')='interviewer') INTO current_person;
    UPDATE public.recruitment_notifications SET state=CASE WHEN NEW.status='cancelled' OR NOT current_person THEN 'cancelled' ELSE 'resolved' END
      WHERE organization_id=NEW.organization_id AND user_id=recipient AND task_key=key AND state='active';
    IF NEW.status='completed' THEN CONTINUE; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.organization_members m JOIN public.users u ON u.id=m.user_id
      WHERE m.organization_id=NEW.organization_id AND m.user_id=recipient AND m.is_active AND u.is_active) THEN CONTINUE; END IF;
    event := 'interview:' || NEW.id::text || ':' || txid_current()::text || ':' || NEW.updated_at::text;
    INSERT INTO public.recruitment_notifications(organization_id,user_id,task_key,event_key,kind,title,description,path,state)
      VALUES(NEW.organization_id,recipient,key,event,
        CASE WHEN NOT current_person OR NEW.status='cancelled' THEN 'removed' WHEN previous THEN 'schedule' ELSE 'assignment' END,
        CASE WHEN NOT current_person THEN '面试安排已移除' WHEN NEW.status='cancelled' THEN '面试已取消' WHEN previous THEN '面试安排已更新' ELSE '收到面试安排' END,
        NEW.title || COALESCE(' · ' || NEW.scheduled_start_at::text,''),
        CASE WHEN current_person AND NEW.status<>'cancelled' THEN '/interviews/' || NEW.id::text ELSE NULL END,
        CASE WHEN NOT current_person OR NEW.status='cancelled' THEN 'cancelled' ELSE 'active' END)
      ON CONFLICT (organization_id,user_id,event_key) DO NOTHING;
  END LOOP;
  RETURN NEW;
END;
$$;
DO $$
DECLARE target record;
BEGIN
  FOR target IN SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relname='interviews' AND c.relkind='r' AND (n.nspname='public' OR n.nspname ~ '^company_[a-f0-9]{32}$')
  LOOP
    EXECUTE format('CREATE TRIGGER interview_assignment_notification AFTER INSERT OR UPDATE ON %I.interviews FOR EACH ROW EXECUTE FUNCTION public.notify_interview_assignment()',target.nspname);
  END LOOP;
END;
$$;
