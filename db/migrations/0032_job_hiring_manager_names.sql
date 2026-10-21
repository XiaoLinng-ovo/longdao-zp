-- The job form accepts one or more display names, not a foreign-key user ID.
-- Keep the existing hiringManagerId API field for compatibility; persist it as text.
ALTER TABLE jobs ADD COLUMN hiring_manager_names text;
COMMENT ON COLUMN jobs.hiring_manager_names IS 'Free-text hiring manager names, including multiple names; exposed as hiringManagerId by the legacy job API';
