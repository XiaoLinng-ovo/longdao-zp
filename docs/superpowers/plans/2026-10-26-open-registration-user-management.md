# Open Registration and Platform User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make open registration atomically create an enterprise owned by the registrant, then expose a platform-admin user directory with detailed account, enterprise, login-safety, and audit information.

**Architecture:** Extend the existing PostgreSQL auth repository with an atomic registration transaction, add a focused platform user service under `apps/api/src/platform/users`, and add a dedicated Vue route and page under `web/src/modules/platform/users`. Platform authorization continues to use live `platform_operators` checks and existing CSRF/origin middleware.

**Tech Stack:** TypeScript, Node HTTP API, PostgreSQL 15+, Vue 3, Vue Router, Vitest, node:test.

## Global Constraints

- Do not add a global `super_admin` role.
- Platform authorization is read from `platform_operators` on every request.
- Platform `viewer` is read-only.
- Registration and enterprise creation must commit or roll back together.
- New enterprises use `kind = 'production'`, `service_status = 'trial'`, and a 14-day trial.
- Registrants become `organization_members.role = 'owner'`.
- Platform user details must not expose resumes, interviews, offers, passwords, Session Tokens, or CSRF Tokens.
- Do not change existing users, enterprises, memberships, or recruitment data during migration.
- Preserve unrelated dirty work.
- All new UI text is Chinese and all new code identifiers are ASCII.

---

### Task 1: Add the registration and user-directory schema

**Files:**
- Create: `db/migrations/0050_open_registration_user_management.sql`
- Modify: `apps/api/src/auth/types.ts`
- Test: `apps/api/src/auth/security.test.ts`

**Interfaces:**
- Produces: `users.phone: text | null`
- Produces: `users.registration_source: 'legacy' | 'open_registration' | 'platform_created'`
- Produces: `registration_attempts(email, ip_address, succeeded, attempted_at)`
- Produces: indexes for user lists and active-session reads.

- [ ] **Step 1: Add migration assertions**

Add a small source-level test proving the migration contains the required columns, checks, and indexes:

```ts
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('open registration migration extends users without resetting existing data', async () => {
  const sql = await readFile(resolve(process.cwd(), 'db/migrations/0050_open_registration_user_management.sql'), 'utf8')
  assert.match(sql, /ADD COLUMN IF NOT EXISTS phone text/u)
  assert.match(sql, /registration_source IN \('legacy', 'open_registration', 'platform_created'\)/u)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS registration_attempts/u)
  assert.match(sql, /users_created_at_idx/u)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix apps/api test -- --test-name-pattern="open registration migration"`

Expected: FAIL because the migration file does not exist.

- [ ] **Step 3: Create the idempotent migration**

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_source text;
UPDATE users SET registration_source = 'legacy' WHERE registration_source IS NULL;
ALTER TABLE users ALTER COLUMN registration_source SET DEFAULT 'legacy';
ALTER TABLE users ALTER COLUMN registration_source SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_registration_source_check
  CHECK (registration_source IN ('legacy', 'open_registration', 'platform_created'));

CREATE TABLE IF NOT EXISTS registration_attempts (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  ip_address inet,
  succeeded boolean NOT NULL DEFAULT false,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS registration_attempts_email_time_idx
  ON registration_attempts(lower(email), attempted_at DESC);
CREATE INDEX IF NOT EXISTS registration_attempts_ip_time_idx
  ON registration_attempts(ip_address, attempted_at DESC);
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS users_active_created_idx ON users(is_active, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_user_last_seen_idx
  ON sessions(user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;
```

Guard the constraint creation so applying the migration twice does not fail:

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_registration_source_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_registration_source_check
      CHECK (registration_source IN ('legacy', 'open_registration', 'platform_created'));
  END IF;
END $$;
```

- [ ] **Step 4: Extend `RegisterInput`**

```ts
export interface RegisterInput {
  name: string
  email: string
  password: string
  companyName: string
  phone?: string
}
```

- [ ] **Step 5: Run the focused test**

Run: `npm --prefix apps/api test -- --test-name-pattern="open registration migration"`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0050_open_registration_user_management.sql apps/api/src/auth/types.ts apps/api/src/auth/security.test.ts
git commit -m "feat: add open registration schema"
```

### Task 2: Make registration atomically create the enterprise and owner

**Files:**
- Modify: `apps/api/src/auth/auth-service.ts`
- Modify: `apps/api/src/auth/session-repository.ts`
- Modify: `apps/api/src/auth/session-store.ts`
- Modify: `apps/api/src/routes.ts`
- Test: `apps/api/src/auth/workspaces.test.ts`
- Test: `apps/api/tests/admin.integration.test.ts`

**Interfaces:**
- Consumes: `RegisterInput.companyName` and `RegisterInput.phone`
- Produces: `AuthService.register(input): Promise<{ user: SessionUser; workspace: WorkspaceSummary }>`
- Produces: `POST /api/v1/auth/register` response `{ user, workspace }`

- [ ] **Step 1: Write failing local-store registration test**

```ts
test('open registration creates an owned enterprise in one operation', async () => {
  const store = new LocalAuthSessionStore(join(directory, 'auth.json'))
  const result = await store.registerUser({
    name: '陈婉清',
    email: 'owner@example.com',
    password: 'strong-password',
    companyName: '龙道科技',
    phone: '13800000000',
  })
  assert.equal(result.workspace.role, 'owner')
  assert.equal(result.workspace.name, '龙道科技')
  assert.deepEqual((await store.listWorkspaces(result.user.id)).map(item => item.role), ['owner'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix apps/api test -- --test-name-pattern="open registration creates an owned enterprise"`

Expected: FAIL because `registerUser` returns only a user.

- [ ] **Step 3: Implement PostgreSQL atomic registration**

Use one transaction and return the inserted user and workspace:

```ts
async registerUser(input: RegisterInput): Promise<{ user: SessionUser; workspace: WorkspaceSummary }> {
  const name = input.name.trim()
  const email = input.email.trim().toLowerCase()
  const companyName = input.companyName.trim()
  const phone = input.phone?.trim() || null
  const passwordHash = await hashPassword(String(input.password))
  const client = await (this.db as Pool).connect()
  try {
    await client.query('BEGIN')
    const user = await client.query(
      `INSERT INTO users (email, display_name, phone, password_hash, registration_source)
       VALUES ($1,$2,$3,$4,'open_registration')
       RETURNING id, email, display_name, phone`,
      [email, name, phone, passwordHash],
    )
    const workspace = await client.query(
      `INSERT INTO organizations (name, kind, created_by, service_status, trial_ends_at)
       VALUES ($1,'production',$2,'trial',now()+interval '14 days')
       RETURNING id, name, kind, status, service_status, trial_ends_at, created_at`,
      [companyName, user.rows[0].id],
    )
    await client.query(
      `INSERT INTO organization_members (organization_id,user_id,role,business_role)
       VALUES ($1,$2,'owner','recruiter')`,
      [workspace.rows[0].id, user.rows[0].id],
    )
    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE code='recruiter' ON CONFLICT DO NOTHING`,
      [user.rows[0].id],
    )
    await client.query('COMMIT')
    return { user: toSessionUser(user.rows[0]), workspace: toWorkspaceSummary(workspace.rows[0]) }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
```

Persist registration attempts in the same repository before the user insert. Reject when the email/IP window exceeds the spec limits.

- [ ] **Step 4: Implement equivalent local-store behavior**

Create the user, workspace, and `workspaceMembers` owner row while holding `exclusive()`; write the JSON file once.

- [ ] **Step 5: Update the route**

```ts
const user = await authService.register({
  name: String(body.name ?? ''),
  email: String(body.email ?? ''),
  password: String(body.password ?? ''),
  companyName: String(body.companyName ?? ''),
  ...(body.phone === undefined ? {} : { phone: String(body.phone) }),
})
sendSuccess(context, user, 201)
```

- [ ] **Step 6: Run focused API tests**

Run: `npm --prefix apps/api test -- --test-name-pattern="registration|workspaces"`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth apps/api/src/routes.ts apps/api/tests/admin.integration.test.ts
git commit -m "feat: create enterprise during open registration"
```

### Task 3: Add platform user service and HTTP endpoints

**Files:**
- Create: `apps/api/src/platform/users/types.ts`
- Create: `apps/api/src/platform/users/validation.ts`
- Create: `apps/api/src/platform/users/service.ts`
- Create: `apps/api/src/platform/users/service.test.ts`
- Modify: `apps/api/src/routes.ts`
- Modify: `apps/api/src/platform/service.test.ts`

**Interfaces:**
- Consumes: `PlatformService.requireAccess(actorId, write)`
- Produces: `PlatformUsersService.list(actorId, searchParams)`
- Produces: `PlatformUsersService.detail(actorId, userId)`
- Produces: `PlatformUsersService.updateStatus(actorId, userId, input, requestId)`
- Produces: `PlatformUsersService.revokeSessions(actorId, userId, input, requestId)`
- Produces: `PlatformUsersService.resetPassword(actorId, userId, input, requestId)`
- Produces: `GET /api/v1/platform/users`
- Produces: `GET /api/v1/platform/users/:id`
- Produces: `PATCH /api/v1/platform/users/:id/status`
- Produces: `POST /api/v1/platform/users/:id/revoke-sessions`
- Produces: `POST /api/v1/platform/users/:id/reset-password`

- [ ] **Step 1: Write failing validation tests**

```ts
test('platform user filters reject invalid status and pagination', () => {
  assert.deepEqual(validateUserListQuery(new URLSearchParams('page=1&pageSize=20')), {
    page: 1, pageSize: 20, q: '', status: null, workspaceId: null, platformRole: null,
  })
  assert.throws(() => validateUserListQuery(new URLSearchParams('page=0')), { code: 'VALIDATION_ERROR' })
  assert.throws(() => validateUserListQuery(new URLSearchParams('status=deleted')), { code: 'VALIDATION_ERROR' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix apps/api test -- --test-name-pattern="platform user filters"`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement validation**

Validate:

```ts
page: 1..1000000
pageSize: 1..100
q: <= 120 characters
status: 'active' | 'disabled' | null
workspaceId: UUID | null
platformRole: 'admin' | 'viewer' | 'none' | null
reason: 2..500 characters
displayName: 2..80 characters
phone: empty/null or E.164 / mainland mobile
```

- [ ] **Step 4: Implement list query**

Use one paginated query and an aggregate for the primary workspace:

```sql
SELECT u.id,u.display_name,u.email,u.phone,u.is_active,u.created_at,u.last_login_at,
       p.role AS platform_role,
       (SELECT count(*) FROM organization_members m WHERE m.user_id=u.id) AS workspace_count,
       ow.id AS workspace_id,ow.name AS workspace_name,ow.kind AS workspace_kind,
       ow.service_status,om.role AS membership_role,om.business_role
FROM users u
LEFT JOIN platform_operators p ON p.user_id=u.id AND p.is_active=true
LEFT JOIN LATERAL (
  SELECT o.id,o.name,o.kind,o.service_status,m.role,m.business_role
  FROM organization_members m JOIN organizations o ON o.id=m.organization_id
  WHERE m.user_id=u.id ORDER BY m.joined_at,o.id LIMIT 1
) ow ON true
LEFT JOIN organization_members om
  ON om.user_id=u.id AND om.organization_id=ow.id
WHERE ($1::text IS NULL OR position(lower($1) in lower(concat_ws(' ',u.display_name,u.email,u.phone,u.id))) > 0)
  AND ($2::text IS NULL OR u.is_active=$2::boolean)
  AND ($3::uuid IS NULL OR ow.id=$3::uuid)
ORDER BY u.created_at DESC,u.id DESC
LIMIT $4 OFFSET $5
```

Never select `password_hash`.

- [ ] **Step 5: Implement detail queries**

Read separately:

- User basics and platform role.
- Workspace memberships joined to organizations and departments.
- Active sessions where `revoked_at IS NULL AND expires_at > now()`.
- Recent 30 enterprise audit rows and platform audit rows relevant to the user.

Return no token columns.

- [ ] **Step 6: Implement mutations**

`updateStatus`:

```ts
if (actorId === userId && !input.isActive) throw new HttpError(409, 'SELF_DISABLE_FORBIDDEN', '不能停用当前登录的平台管理员')
```

Inside one transaction:

- Require platform admin with `FOR SHARE`.
- Lock the target user.
- Protect the last active platform admin.
- Update `users.is_active`.
- Revoke sessions when disabling.
- Insert `platform_audit_logs`.

`revokeSessions` updates `sessions.revoked_at = now()` and audits the count.

`resetPassword` generates an initial password, writes the hash, revokes sessions, returns the temporary password once, and never puts it in audit metadata.

- [ ] **Step 7: Add endpoints**

Add the routes before `/api/v1/platform/customers` handling:

```ts
if (path === '/api/v1/platform/users' && method === 'GET') {
  sendSuccess(context, await platformUsers.list(auth.user.id, context.url.searchParams))
  return
}
```

Use `requireAuth(context)` and let `createPlatformAccessMiddleware` enforce live platform permissions and write security.

- [ ] **Step 8: Run focused API tests**

Run: `npm --prefix apps/api test -- --test-name-pattern="platform user|registration"`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/platform/users apps/api/src/routes.ts apps/api/src/platform/service.test.ts
git commit -m "feat: expose platform user management API"
```

### Task 4: Update registration UI and automatic enterprise selection

**Files:**
- Modify: `web/src/modules/auth/api/index.ts`
- Modify: `web/src/modules/auth/pages/RegisterPage.vue`
- Modify: `web/src/modules/auth/session.ts`
- Test: `web/src/modules/auth/pages/RegisterPage.test.ts`

**Interfaces:**
- Consumes: `POST /auth/register` response `{ user, workspace }`
- Produces: `register(input): Promise<{ user: AuthUser; workspace: WorkspaceSummary }>`
- Produces: `loginWithEmail(...): Promise<WorkspaceSummary[]>`
- Produces: post-registration `switchWorkspace(workspace.id)` when exactly one workspace exists.

- [ ] **Step 1: Write the failing registration page test**

```ts
it('creates the enterprise and selects it after registration', async () => {
  mockedRegister.mockResolvedValue({
    user: { id: 'u1', name: ' Owner ', email: 'owner@example.com', role: 'recruiter', departmentId: '' },
    workspace: { id: 'w1', name: '龙道科技', kind: 'production', status: 'active', role: 'owner', createdAt: '2026-10-26' },
  })
  mockedLogin.mockResolvedValue([mockedRegister.mock.results[0].value.workspace])
  await mountAndSubmit()
  expect(mockedRegister).toHaveBeenCalledWith(expect.objectContaining({ companyName: '龙道科技' }))
  expect(mockedSwitchWorkspace).toHaveBeenCalledWith('w1')
  expect(router.push).toHaveBeenCalledWith('/')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- RegisterPage.test.ts`

Expected: FAIL because the form has no enterprise field.

- [ ] **Step 3: Update the API contract**

```ts
export interface RegisterInput {
  name: string
  email: string
  password: string
  companyName: string
  phone?: string
}

export async function register(input: RegisterInput): Promise<{ user: AuthUser; workspace: WorkspaceSummary }> {
  return (await apiClient.postJson('/auth/register', input)).data
}
```

- [ ] **Step 4: Update the form**

Add required fields:

- 企业名称
- 手机号，可选

Update explanatory copy to state that registration creates the enterprise and the registrant becomes owner.

After login:

```ts
const workspaces = await loginWithEmail(email, password)
const created = workspaces.find((item) => item.id === registration.workspace.id)
if (workspaces.length === 1 && created) {
  await switchWorkspace(created.id)
  await router.push('/')
} else {
  await router.push('/workspaces')
}
```

- [ ] **Step 5: Run focused web tests**

Run: `npm --prefix web test -- RegisterPage.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/modules/auth
git commit -m "feat: create enterprise during registration flow"
```

### Task 5: Add the platform user directory page

**Files:**
- Create: `web/src/modules/platform/users/api/index.ts`
- Create: `web/src/modules/platform/users/pages/PlatformUsersPage.vue`
- Create: `web/src/modules/platform/users/components/UserDetailDrawer.vue`
- Create: `web/src/modules/platform/users/pages/PlatformUsersPage.test.ts`
- Modify: `web/src/app/routes.ts`
- Modify: `web/src/app/router.ts`

**Interfaces:**
- Consumes: platform user endpoints from Task 3.
- Produces: route `/platform/users`
- Produces: navigation label `用户管理` under `平台运营`
- Produces: old `administration?module=users` redirect to `/platform/users`.

- [ ] **Step 1: Write the failing page test**

```ts
it('loads users and opens the selected detail drawer', async () => {
  mockedListPlatformUsers.mockResolvedValue({
    items: [user],
    total: 1,
    page: 1,
    pageSize: 20,
  })
  mockedGetPlatformUser.mockResolvedValue(detail)
  const { root } = mountPage(PlatformUsersPage)
  await flush()
  expect(root.textContent).toContain('陈婉清')
  await root.querySelector('[data-testid="user-row-u1"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flush()
  expect(mockedGetPlatformUser).toHaveBeenCalledWith('u1')
  expect(root.textContent).toContain('企业归属')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- PlatformUsersPage.test.ts`

Expected: FAIL because the page and route do not exist.

- [ ] **Step 3: Implement API client**

Export typed functions:

```ts
listPlatformUsers(params): Promise<PlatformUserListResponse>
getPlatformUser(id): Promise<PlatformUserDetail>
updatePlatformUserStatus(id, input): Promise<void>
revokePlatformUserSessions(id, input): Promise<{ revokedSessions: number }>
resetPlatformUserPassword(id, input): Promise<{ temporaryPassword: string; revokedSessions: number }>
```

- [ ] **Step 4: Implement the list and detail UI**

Use existing shared table, button, status, and feedback styles. Keep:

- Search and filters.
- Pagination.
- Fixed detail drawer on desktop.
- Full-height detail panel on mobile.
- Tabs for account, enterprise memberships, login safety, and audit.
- Status and security action dialogs requiring a reason.
- Explicit privacy notice.

- [ ] **Step 5: Add route and redirect**

```ts
{
  path: '/platform/users',
  name: 'platform-users',
  component: () => import('../modules/platform/users/pages/PlatformUsersPage.vue'),
  meta: {
    title: '用户管理',
    navLabel: '用户管理',
    icon: '◎',
    group: '平台运营',
    crumb: '平台运营 / 用户管理',
    platformOnly: true,
  },
}
```

In `web/src/app/router.ts`, when `to.name === 'administration' && to.query.module === 'users'`, redirect to `{ name: 'platform-users' }`.

- [ ] **Step 6: Run focused web tests and typecheck**

Run: `npm --prefix web test -- PlatformUsersPage.test.ts`

Expected: PASS.

Run: `npm --prefix web run typecheck`

Expected: exit code 0.

- [ ] **Step 7: Commit**

```bash
git add web/src/modules/platform/users web/src/app/routes.ts web/src/app/router.ts
git commit -m "feat: add platform user directory"
```

### Task 6: End-to-end verification and delivery notes

**Files:**
- Modify: `docs/workspace-invitations.md`
- Create: `docs/open-registration-user-management.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: operator instructions and verification evidence.

- [ ] **Step 1: Document the new flow**

Include:

- Registration fields and 14-day trial.
- Platform user directory route.
- Read-only viewer behavior.
- Platform support actions and reasons.
- Explicit privacy boundary.
- Migration and build commands.

- [ ] **Step 2: Run API tests**

Run: `npm --prefix apps/api test`

Expected: all tests pass; PostgreSQL integration tests may skip only when database credentials are absent.

- [ ] **Step 3: Run Web tests and build**

Run: `npm --prefix web test`

Expected: all tests pass.

Run: `npm --prefix web run typecheck`

Expected: exit code 0.

Run: `npm --prefix web run build`

Expected: production build succeeds.

- [ ] **Step 4: Run diff checks**

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 5: Inspect runtime with PostgreSQL**

If PostgreSQL is available:

1. Apply migration 0050.
2. Register a test enterprise.
3. Verify the user appears in `/api/v1/platform/users`.
4. Verify the registrant is owner of the created enterprise.
5. Verify platform viewer receives 403 on writes.
6. Verify stop, revoke sessions, and password reset invalidate old sessions.

Expected: every check matches the spec.

- [ ] **Step 6: Commit**

```bash
git add docs/open-registration-user-management.md docs/workspace-invitations.md
git commit -m "docs: document open registration and platform users"
```
