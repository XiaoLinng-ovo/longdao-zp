-- Freeze historical effective permissions once; never inherit global role changes again.
SET LOCAL lock_timeout = '5s';
ALTER TABLE organization_members DROP CONSTRAINT organization_members_business_role_check;
ALTER TABLE organization_members ADD CONSTRAINT organization_members_business_role_check
  CHECK (business_role IN ('recruiter','hiring_manager','approver','interviewer','admin','hr_admin'));

WITH migrated AS (
  UPDATE organization_members m SET
    business_role = COALESCE((SELECT r.code FROM user_roles ur JOIN roles r ON r.id=ur.role_id
      WHERE ur.user_id=m.user_id ORDER BY r.code LIMIT 1),'recruiter'),
    department_id = u.department_id
  FROM users u WHERE u.id=m.user_id AND m.business_role IS NULL
  RETURNING m.organization_id,m.user_id,m.business_role,m.department_id
)
INSERT INTO audit_logs(organization_id,action,resource_type,resource_id,metadata)
SELECT organization_id,'workspace.member.role_snapshot','organization_member',user_id,
  jsonb_build_object('businessRole',business_role,'departmentId',department_id,'source','legacy_global_snapshot','migration','0039')
FROM migrated;

ALTER TABLE organization_members ALTER COLUMN business_role SET DEFAULT 'recruiter';
ALTER TABLE organization_members ALTER COLUMN business_role SET NOT NULL;
