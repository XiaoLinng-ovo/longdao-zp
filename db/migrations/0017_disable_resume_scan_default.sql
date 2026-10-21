-- Keep new deployments consistent with the disabled scanner policy.
ALTER TABLE resumes ALTER COLUMN scan_status SET DEFAULT 'clean';
