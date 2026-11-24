-- Trial accounts may upload at most three resumes and conduct at most three
-- real interviews. Interview records may still be created and rescheduled.

CREATE TABLE IF NOT EXISTS organization_trial_usage (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  resume_uploads integer NOT NULL DEFAULT 0 CHECK (resume_uploads >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organization_trial_usage (organization_id, resume_uploads)
SELECT o.id,
       LEAST((SELECT count(*)::integer FROM resumes r WHERE r.organization_id = o.id), 3)
FROM organizations o
WHERE o.service_status = 'trial'
ON CONFLICT (organization_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS organization_trial_interviews (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  interview_id uuid NOT NULL,
  counted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, interview_id)
);

-- Existing live sessions or submitted feedback are evidence that an interview
-- was actually conducted before this migration.
INSERT INTO organization_trial_interviews (organization_id, interview_id, counted_at)
SELECT i.organization_id, i.id,
       COALESCE(min(ls.started_at), min(f.submitted_at), min(f.locked_at), i.updated_at)
FROM interviews i
JOIN organizations o ON o.id = i.organization_id AND o.service_status = 'trial'
LEFT JOIN interview_live_sessions ls ON ls.interview_id = i.id
LEFT JOIN interview_feedback f ON f.interview_id = i.id AND f.status IN ('submitted', 'locked')
WHERE ls.id IS NOT NULL OR f.id IS NOT NULL
GROUP BY i.organization_id, i.id, i.updated_at
ON CONFLICT (organization_id, interview_id) DO NOTHING;

CREATE OR REPLACE FUNCTION enforce_trial_resume_quota()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  organization_status text;
  next_count integer;
BEGIN
  SELECT service_status INTO organization_status
  FROM organizations
  WHERE id = NEW.organization_id;

  IF organization_status IS DISTINCT FROM 'trial' THEN
    RETURN NEW;
  END IF;

  INSERT INTO organization_trial_usage (organization_id)
  VALUES (NEW.organization_id)
  ON CONFLICT (organization_id) DO NOTHING;

  UPDATE organization_trial_usage
     SET resume_uploads = resume_uploads + 1,
         updated_at = now()
   WHERE organization_id = NEW.organization_id
     AND resume_uploads < 3
  RETURNING resume_uploads INTO next_count;
  IF next_count IS NULL THEN
    RAISE EXCEPTION 'TRIAL_RESUME_LIMIT_REACHED' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_trial_interview_quota()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  organization_status text;
  interview_organization_id uuid;
  used_count integer;
BEGIN
  SELECT o.service_status, i.organization_id
    INTO organization_status, interview_organization_id
  FROM interviews i
  JOIN organizations o ON o.id = i.organization_id
  WHERE i.id = NEW.interview_id;

  IF organization_status IS DISTINCT FROM 'trial' THEN
    RETURN NEW;
  END IF;

  -- Serialize quota consumption per enterprise before the duplicate check.
  PERFORM 1 FROM organizations
  WHERE id = interview_organization_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM organization_trial_interviews
    WHERE organization_id = interview_organization_id
      AND interview_id = NEW.interview_id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer INTO used_count
  FROM organization_trial_interviews
  WHERE organization_id = interview_organization_id;

  IF used_count >= 3 THEN
    RAISE EXCEPTION 'TRIAL_INTERVIEW_LIMIT_REACHED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO organization_trial_interviews (organization_id, interview_id)
  VALUES (interview_organization_id, NEW.interview_id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS resumes_enforce_trial_quota ON resumes;
CREATE TRIGGER resumes_enforce_trial_quota
  BEFORE INSERT ON resumes
  FOR EACH ROW
  EXECUTE FUNCTION enforce_trial_resume_quota();

DROP TRIGGER IF EXISTS interview_live_sessions_enforce_trial_quota ON interview_live_sessions;
CREATE TRIGGER interview_live_sessions_enforce_trial_quota
  BEFORE INSERT ON interview_live_sessions
  FOR EACH ROW
  EXECUTE FUNCTION enforce_trial_interview_quota();

DROP TRIGGER IF EXISTS interview_feedback_enforce_trial_quota ON interview_feedback;
CREATE TRIGGER interview_feedback_enforce_trial_quota
  BEFORE INSERT OR UPDATE OF status ON interview_feedback
  FOR EACH ROW
  WHEN (NEW.status IN ('submitted', 'locked'))
  EXECUTE FUNCTION enforce_trial_interview_quota();
