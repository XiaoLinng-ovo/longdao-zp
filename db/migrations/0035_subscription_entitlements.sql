-- Run inside the migration transaction: block concurrent membership/job writes while
-- backfilling counters and installing triggers. No rows are deleted or reassigned.
SET LOCAL lock_timeout = '10s';
LOCK TABLE organizations, organization_members, jobs IN ACCESS EXCLUSIVE MODE;

-- Immutable versions: publishing a new version never changes assigned customer rights.
CREATE TABLE subscription_plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_-]{1,39}$'),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  seat_limit integer CHECK (seat_limit BETWEEN 1 AND 1000000),
  job_limit integer CHECK (job_limit BETWEEN 1 AND 1000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(code,version),
  CHECK ((code = 'legacy' AND seat_limit IS NULL AND job_limit IS NULL)
    OR (code <> 'legacy' AND seat_limit IS NOT NULL AND job_limit IS NOT NULL))
);
INSERT INTO subscription_plan_versions(id,code,version,name,seat_limit,job_limit) VALUES
 ('00000000-0000-4000-8000-000000000051','legacy',1,'历史兼容权益',NULL,NULL),
 ('00000000-0000-4000-8000-000000000052','trial',1,'试用版',5,20),
 ('00000000-0000-4000-8000-000000000053','team',1,'团队版',20,200),
 ('00000000-0000-4000-8000-000000000054','growth',1,'成长版',100,2000);
CREATE FUNCTION immutable_subscription_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Plan versions are immutable' USING ERRCODE='P5503'; END; $$;
CREATE TRIGGER immutable_subscription_plan BEFORE UPDATE OR DELETE ON subscription_plan_versions
 FOR EACH ROW EXECUTE FUNCTION immutable_subscription_plan();
ALTER TABLE organizations ADD COLUMN plan_version_id uuid REFERENCES subscription_plan_versions(id) ON DELETE RESTRICT;
-- Preserve existing clients without silently imposing a new commercial limit.
UPDATE organizations SET plan_version_id='00000000-0000-4000-8000-000000000051';
ALTER TABLE organizations ALTER COLUMN plan_version_id SET NOT NULL;
ALTER TABLE organizations ALTER COLUMN plan_version_id SET DEFAULT '00000000-0000-4000-8000-000000000052';
ALTER TABLE organizations ADD COLUMN entitlement_version integer NOT NULL DEFAULT 1 CHECK(entitlement_version>0);
ALTER TABLE organizations ADD COLUMN seat_usage integer NOT NULL DEFAULT 0 CHECK(seat_usage>=0);
ALTER TABLE organizations ADD COLUMN job_usage integer NOT NULL DEFAULT 0 CHECK(job_usage>=0);
UPDATE organizations o SET seat_usage=(SELECT count(*) FROM organization_members m WHERE m.organization_id=o.id),
 job_usage=(SELECT count(*) FROM jobs j WHERE j.organization_id=o.id);
-- AFTER INSERT does not charge INSERT ... ON CONFLICT DO NOTHING. Counters and writes
-- commit/roll back together. Each organization row serializes concurrent acquisitions
-- and package changes, avoiding count-then-insert races across API/worker processes.
CREATE FUNCTION maintain_organization_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id uuid; target_id uuid; seats integer; jobs_count integer;
 seat_cap integer; job_cap integer;
BEGIN
 IF TG_OP <> 'INSERT' THEN source_id=OLD.organization_id; END IF;
 IF TG_OP <> 'DELETE' THEN target_id=NEW.organization_id; END IF;
 IF source_id IS NOT DISTINCT FROM target_id THEN RETURN NULL; END IF;
 -- Deterministic lock order also handles transfers between organizations.
 PERFORM id FROM organizations WHERE id IN (source_id,target_id) ORDER BY id FOR NO KEY UPDATE;
 IF source_id IS NOT NULL THEN
  IF TG_TABLE_NAME='organization_members' THEN UPDATE organizations SET seat_usage=seat_usage-1 WHERE id=source_id;
  ELSE UPDATE organizations SET job_usage=job_usage-1 WHERE id=source_id; END IF;
 END IF;
 IF target_id IS NOT NULL THEN
  SELECT o.seat_usage,o.job_usage,p.seat_limit,p.job_limit INTO seats,jobs_count,seat_cap,job_cap
   FROM organizations o JOIN subscription_plan_versions p ON p.id=o.plan_version_id WHERE o.id=target_id;
  IF TG_TABLE_NAME='organization_members' THEN
   IF seat_cap IS NOT NULL AND seats>=seat_cap THEN
    RAISE EXCEPTION 'SEAT_LIMIT_EXCEEDED' USING ERRCODE='P5501';
   END IF;
   UPDATE organizations SET seat_usage=seat_usage+1 WHERE id=target_id;
  ELSE
   IF job_cap IS NOT NULL AND jobs_count>=job_cap THEN
    RAISE EXCEPTION 'JOB_LIMIT_EXCEEDED' USING ERRCODE='P5502';
   END IF;
   UPDATE organizations SET job_usage=job_usage+1 WHERE id=target_id;
  END IF;
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER organization_member_capacity AFTER INSERT OR DELETE OR UPDATE OF organization_id ON organization_members
 FOR EACH ROW EXECUTE FUNCTION maintain_organization_capacity();
CREATE TRIGGER organization_job_capacity AFTER INSERT OR DELETE OR UPDATE OF organization_id ON jobs
 FOR EACH ROW EXECUTE FUNCTION maintain_organization_capacity();
