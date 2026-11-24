ALTER TABLE offer_versions
  ADD COLUMN IF NOT EXISTS reporting_location text;
