# 部门管理与招聘需求下拉选择 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add administrator-managed departments and dynamic active-department selectors to requisition forms.

**Architecture:** Reuse the existing PostgreSQL `departments` table and `AdminService`; expose authenticated read access and admin-only CRUD-like create/update endpoints. Requisition pages load active departments through their API module, while the administration page manages all rows with soft deactivation.

**Tech Stack:** Node.js TypeScript HTTP API, PostgreSQL, Vue 3, Vitest, Vue Test Utils.

## Global Constraints

- Department codes are stable references and are never edited through the UI.
- Deactivation is soft; existing records remain valid and visible.
- PostgreSQL remains the source of truth in non-test environments.

### Task 1: Department service and API

**Files:** `apps/api/src/admin/service.ts`, `apps/api/src/admin/service.test.ts`, `apps/api/src/routes.ts`

- Add `AdminDepartmentRecord`, `AdminDepartmentCreate`, and `AdminDepartmentUpdate`.
- Implement list/create/update with validation, duplicate handling, and audit logs.
- Add authenticated `/departments` read route and admin-only `/admin/departments` read/create/update routes.
- Test SQL-boundary behavior and route-facing error codes.

### Task 2: Requisition department API and selectors

**Files:** `web/src/modules/requisitions/api/index.ts`, `web/src/modules/requisitions/api/index.test.ts`, `web/src/modules/requisitions/pages/RequisitionListPage.vue`, `web/src/modules/requisitions/pages/RequisitionDetailPage.vue`

- Add `ApiDepartment` and `loadDepartments`.
- Load active departments on form open/page mount, show name and code, and submit the selected code.
- Preserve current department when editing even if it has since been deactivated; show it as a disabled legacy option.
- Add API and page regression tests.

### Task 3: Administration department management

**Files:** `web/src/modules/administration/api/index.ts`, `web/src/modules/administration/pages/AdministrationPage.vue`, `web/src/modules/administration/pages/AdministrationPage.test.ts`

- Add department API methods and types.
- Add create form and table actions for rename/activate/deactivate.
- Use department options in the user department editor.
- Add page coverage for display and save actions.

### Task 4: Verification

- Run focused tests, then `pnpm -r test`, web typecheck/build, and `git diff --check`.
