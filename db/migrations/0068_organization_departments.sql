-- Make departments tenant-owned while preserving legacy references.
--
-- Departments predate workspace isolation and were shared globally. A shared
-- department cannot be assigned to two organizations through a single row, so
-- the first organization keeps the original row and every other organization
-- receives a cloned row. Related memberships, invitations, requests and jobs
-- are then rebound to the organization-specific copy.

ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS departments_organization_name_idx
  ON departments (organization_id, name)
  WHERE organization_id IS NOT NULL;

CREATE TEMP TABLE _department_org_links ON COMMIT DROP AS
SELECT DISTINCT department_id, organization_id
FROM (
  SELECT department_id, organization_id
    FROM organization_members
   WHERE department_id IS NOT NULL
  UNION ALL
  SELECT department_id, organization_id
    FROM organization_invitations
   WHERE department_id IS NOT NULL
  UNION ALL
  SELECT department_id, organization_id
    FROM recruitment_requests
   WHERE department_id IS NOT NULL AND organization_id IS NOT NULL
  UNION ALL
  SELECT department_id, organization_id
    FROM jobs
   WHERE department_id IS NOT NULL AND organization_id IS NOT NULL
) linked_departments;

-- Deterministically choose the organization that keeps each legacy row.
WITH ranked_links AS (
  SELECT l.department_id,
         l.organization_id,
         row_number() OVER (
           PARTITION BY l.department_id
           ORDER BY o.created_at, o.id
         ) AS position
    FROM _department_org_links l
    JOIN organizations o ON o.id = l.organization_id
)
UPDATE departments d
   SET organization_id = ranked.organization_id
  FROM ranked_links ranked
 WHERE d.id = ranked.department_id
   AND ranked.position = 1
   AND d.organization_id IS DISTINCT FROM ranked.organization_id;

-- Keep departments with no legacy business references visible instead of
-- leaving them orphaned. Prefer the oldest active organization with the most
-- members; if no active organization exists, retain any organization deterministically.
WITH fallback_organization AS (
  SELECT o.id
    FROM organizations o
   ORDER BY CASE WHEN o.status = 'active' THEN 0 ELSE 1 END,
            (SELECT count(*) FROM organization_members m WHERE m.organization_id = o.id) DESC,
            o.created_at,
            o.id
   LIMIT 1
)
UPDATE departments d
   SET organization_id = fallback.id
  FROM fallback_organization fallback
 WHERE d.organization_id IS NULL;

CREATE TEMP TABLE _department_clone_map ON COMMIT DROP AS
SELECT gen_random_uuid() AS new_department_id,
       d.id AS old_department_id,
       d.parent_id AS old_parent_id,
       d.code AS old_code,
       d.name,
       d.is_active,
       d.created_at,
       d.updated_at,
       l.organization_id
  FROM _department_org_links l
  JOIN departments d ON d.id = l.department_id
 WHERE d.organization_id IS DISTINCT FROM l.organization_id;

INSERT INTO departments (id, parent_id, code, name, is_active, created_at, updated_at, organization_id)
SELECT map.new_department_id,
       NULL,
       'dept-' || substr(replace(map.new_department_id::text, '-', ''), 1, 16),
       map.name,
       map.is_active,
       map.created_at,
       map.updated_at,
       map.organization_id
  FROM _department_clone_map map;

-- Resolve child parent links inside each organization after all clones exist.
UPDATE departments child
   SET parent_id = COALESCE(
         (SELECT parent_map.new_department_id
            FROM _department_clone_map map
            JOIN _department_clone_map parent_map
              ON parent_map.old_department_id = map.old_parent_id
             AND parent_map.organization_id = map.organization_id
           WHERE map.new_department_id = child.id),
         (SELECT parent.id
            FROM _department_clone_map map
            JOIN departments parent
              ON parent.id = map.old_parent_id
             AND parent.organization_id = map.organization_id
           WHERE map.new_department_id = child.id)
       )
 WHERE child.id IN (SELECT new_department_id FROM _department_clone_map);

UPDATE organization_members target
   SET department_id = map.new_department_id
  FROM _department_clone_map map
 WHERE target.organization_id = map.organization_id
   AND target.department_id = map.old_department_id;

UPDATE organization_invitations target
   SET department_id = map.new_department_id
  FROM _department_clone_map map
 WHERE target.organization_id = map.organization_id
   AND target.department_id = map.old_department_id;

UPDATE recruitment_requests target
   SET department_id = map.new_department_id
  FROM _department_clone_map map
 WHERE target.organization_id = map.organization_id
   AND target.department_id = map.old_department_id;

UPDATE jobs target
   SET department_id = map.new_department_id
  FROM _department_clone_map map
 WHERE target.organization_id = map.organization_id
   AND target.department_id = map.old_department_id;

INSERT INTO department_approval_policies
  (department_id, subject_type, process_code, steps, is_active, created_at, updated_at)
SELECT map.new_department_id,
       policy.subject_type,
       policy.process_code,
       policy.steps,
       policy.is_active,
       policy.created_at,
       policy.updated_at
  FROM _department_clone_map map
  JOIN department_approval_policies policy
    ON policy.department_id = map.old_department_id;

-- users.department_id is a legacy global field and cannot represent multiple
-- organizations. Rebind it only when the user belongs to exactly one organization.
WITH member_organization_counts AS (
  SELECT user_id, count(*) AS organization_count
    FROM organization_members
   GROUP BY user_id
), single_organization_members AS (
  SELECT membership.user_id, membership.organization_id
    FROM organization_members membership
    JOIN member_organization_counts counts ON counts.user_id = membership.user_id
   WHERE counts.organization_count = 1
)
UPDATE users target
   SET department_id = map.new_department_id
  FROM single_organization_members membership
  JOIN _department_clone_map map
    ON map.organization_id = membership.organization_id
 WHERE target.id = membership.user_id
   AND target.department_id = map.old_department_id;
