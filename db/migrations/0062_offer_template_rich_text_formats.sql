ALTER TABLE offer_templates
  DROP CONSTRAINT IF EXISTS offer_templates_filename_check;

ALTER TABLE offer_templates
  ADD CONSTRAINT offer_templates_filename_check
  CHECK (filename ~* '[.](md|html?|txt)$');
