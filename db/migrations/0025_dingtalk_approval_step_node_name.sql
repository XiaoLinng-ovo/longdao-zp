-- Backfill columns introduced by the DingTalk approval workflow for databases
-- where migration 0013 was recorded before node_name was added.
ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS node_name text;