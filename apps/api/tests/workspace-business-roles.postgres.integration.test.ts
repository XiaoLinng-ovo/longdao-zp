import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createPostgresHealthPool } from '../src/recruiting/db-health.js'
import { PostgresSessionRepository } from '../src/auth/session-repository.js'
import { WorkspaceInvitationsService } from '../src/auth/workspace-invitations.js'
import type { Role } from '../src/auth/types.js'

test('workspace business roles stay local across global changes, selection, session refresh and revocation', async t => {
  assert.equal(process.env.PGPORT, '15433'); assert.equal(process.env.PGDATABASE, 'smartrecruit_test')
  const pool = createPostgresHealthPool(), repository = new PostgresSessionRepository(pool)
  const actor = randomUUID(), owner = randomUUID(), a = randomUUID(), b = randomUUID(), department = randomUUID()
  const organizations: string[] = [a, b], tokens: string[] = []
  try {
    await pool.query("INSERT INTO departments(id,code,name) VALUES($1,$2,'Role fixture')", [department, 'ROLE-' + department])
    await pool.query("INSERT INTO users(id,email,display_name,department_id) VALUES($1,$3,'Role fixture',$5),($2,$4,'Role owner',NULL)", [actor, owner, actor + '@example.invalid', owner + '@example.invalid', department])
    const adminRole = (await pool.query("SELECT id FROM roles WHERE code='admin'")).rows[0].id
    await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [actor, adminRole])
    await pool.query("INSERT INTO organizations(id,name,kind) VALUES($1,'Role fixture A','test'),($2,'Role fixture B','test')", [a, b])
    await pool.query("INSERT INTO organization_members(organization_id,user_id,role,business_role,department_id) VALUES($1,$3,'member','interviewer',NULL),($2,$3,'member','hiring_manager',$5),($1,$4,'owner','recruiter',NULL)", [a, b, actor, owner, department])
    const session = await repository.createSession({ id: actor, name: 'Fixture', email: actor + '@example.invalid', role: 'admin', departmentId: department })
    tokens.push(session.token)
    await t.test('global admin is interviewer in A and department manager only in B', async () => {
      const selectedA = await repository.selectWorkspace(session.session.sessionId, actor, a)
      assert.equal(selectedA.role, 'interviewer'); assert.equal(selectedA.departmentId, ''); assert.equal(selectedA.platformRole, undefined)
      assert.equal((await repository.findSessionByToken(session.token))?.user.role, 'interviewer')
      const selectedB = await repository.selectWorkspace(session.session.sessionId, actor, b)
      assert.equal(selectedB.role, 'hiring_manager'); assert.equal(selectedB.departmentId, 'ROLE-' + department)
      assert.equal((await repository.findSessionByToken(session.token))?.user.departmentId, selectedB.departmentId)
    })
    await t.test('global role and department updates cannot mutate selected enterprise permissions or member directory', async () => {
      await pool.query('DELETE FROM user_roles WHERE user_id=$1', [actor])
      await pool.query('UPDATE users SET department_id=NULL WHERE id=$1', [actor])
      assert.equal((await repository.findSessionByToken(session.token))?.user.role, 'hiring_manager')
      assert.equal((await repository.findSessionByToken(session.token))?.user.departmentId, 'ROLE-' + department)
      assert.equal((await new WorkspaceInvitationsService(pool).members(a, owner)).find(m => m.id === actor)?.businessRole, 'interviewer')
      await pool.query("UPDATE organization_members SET business_role='approver',department_id=NULL WHERE organization_id=$1 AND user_id=$2", [b, actor])
      const refreshed = await repository.findSessionByToken(session.token)
      assert.equal(refreshed?.user.role, 'approver'); assert.equal(refreshed?.user.departmentId, '')
      await repository.selectWorkspace(session.session.sessionId, actor, a)
      assert.equal((await repository.findSessionByToken(session.token))?.user.role, 'interviewer')
    })
    await t.test('revoked or unavailable scope does not resurrect global admin privileges', async () => {
      await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [actor, adminRole])
      await pool.query('DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2', [a, actor])
      const revoked = await repository.findSessionByToken(session.token)
      assert.equal(revoked?.user.workspaceId, undefined); assert.equal(revoked?.user.workspaceAccessIssue, 'unavailable')
      assert.equal(revoked?.user.role, 'recruiter'); assert.equal(revoked?.user.departmentId, '')
      await assert.rejects(repository.selectWorkspace(session.session.sessionId, actor, a), { status: 403 })
      await pool.query('UPDATE users SET is_active=false WHERE id=$1', [actor])
      await assert.rejects(repository.selectWorkspace(session.session.sessionId, actor, b), { status: 403 })
      await pool.query('UPDATE users SET is_active=true WHERE id=$1', [actor])
      await repository.selectWorkspace(session.session.sessionId, actor, b)
      await pool.query("UPDATE organizations SET service_status='suspended' WHERE id=$1", [b])
      const suspended = await repository.findSessionByToken(session.token)
      assert.equal(suspended?.user.role, 'recruiter'); assert.equal(suspended?.user.workspaceId, undefined)
    })
    await t.test('new enterprise owner retains management identity without inheriting global admin or department', async () => {
      const created = await repository.createWorkspace(actor, { name: 'Role new owner fixture', kind: 'test' })
      organizations.push(created.id)
      const member = (await pool.query('SELECT role,business_role,department_id FROM organization_members WHERE organization_id=$1 AND user_id=$2', [created.id, actor])).rows[0]
      assert.deepEqual(member, { role: 'owner', business_role: 'recruiter', department_id: null })
      const selected = await repository.selectWorkspace(session.session.sessionId, actor, created.id)
      assert.equal(selected.role, 'recruiter'); assert.equal(selected.departmentId, '')
      assert.equal((await repository.listWorkspaces(actor)).find(w => w.id === created.id)?.role, 'owner')
      const notes = await new WorkspaceInvitationsService(pool).members(created.id, actor)
      assert.equal(notes.length, 1)
    })
  } finally {
    await pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [[actor, owner]])
    await pool.query('DELETE FROM audit_logs WHERE organization_id=ANY($1::uuid[])', [organizations])
    await pool.query('DELETE FROM organization_members WHERE organization_id=ANY($1::uuid[])', [organizations])
    await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [organizations])
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[actor, owner]])
    await pool.query('DELETE FROM departments WHERE id=$1', [department]); await pool.end()
  }
})

test('0039 preserves old effective roles once, audits snapshots and rejects NULL after migration', async () => {
  assert.equal(process.env.PGPORT, '15433'); assert.equal(process.env.PGDATABASE, 'smartrecruit_test')
  const pool = createPostgresHealthPool(), db = await pool.connect(), org = randomUUID(), dept = randomUUID()
  const roles: Role[] = ['admin', 'hr_admin', 'hiring_manager', 'recruiter', 'approver', 'interviewer']
  const users = roles.map(() => randomUUID()), explicit = randomUUID(), noRole = randomUUID()
  await db.query('BEGIN')
  try {
    // Reconstruct pre-0039 rows inside a rolled-back transaction, not in the business database.
    await db.query('ALTER TABLE organization_members ALTER COLUMN business_role DROP NOT NULL')
    await db.query("INSERT INTO organizations(id,name,kind,plan_version_id) VALUES($1,'Migration fixture','test','00000000-0000-4000-8000-000000000051')", [org])
    await db.query("INSERT INTO departments(id,code,name) VALUES($1,$2,'Snapshot dept')", [dept, 'SNAP-' + dept])
    for (let i = 0; i < roles.length; i++) {
      const id = users[i]!, role = roles[i]!
      await db.query("INSERT INTO roles(code,name) VALUES($1,$1) ON CONFLICT(code) DO NOTHING", [role])
      await db.query("INSERT INTO users(id,email,display_name,department_id) VALUES($1,$2,'Snapshot fixture',$3)", [id, id + '@example.invalid', dept])
      await db.query('INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2', [id, role])
      await db.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'member',NULL)", [org, id])
    }
    for (const id of [explicit, noRole]) await db.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Snapshot fixture')", [id, id + '@example.invalid'])
    await db.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'member','interviewer'),($1,$3,'member',NULL)", [org, explicit, noRole])
    const sql = await readFile(new URL('../../../../db/migrations/0039_workspace_business_roles.sql', import.meta.url), 'utf8')
    await db.query(sql)
    const members = (await db.query('SELECT user_id,business_role,department_id FROM organization_members WHERE organization_id=$1', [org])).rows
    for (let i = 0; i < roles.length; i++) assert.deepEqual(members.find(m => m.user_id === users[i]), { user_id: users[i], business_role: roles[i], department_id: dept })
    assert.equal(members.find(m => m.user_id === explicit)?.business_role, 'interviewer')
    assert.equal(members.find(m => m.user_id === noRole)?.business_role, 'recruiter')
    assert.equal((await db.query("SELECT count(*)::int AS count FROM audit_logs WHERE organization_id=$1 AND action='workspace.member.role_snapshot'", [org])).rows[0].count, 7)
    await db.query('DELETE FROM user_roles WHERE user_id=ANY($1::uuid[])', [users])
    assert.equal((await db.query('SELECT business_role FROM organization_members WHERE organization_id=$1 AND user_id=$2', [org, users[0]])).rows[0].business_role, 'admin')
    await db.query('SAVEPOINT invalid_role')
    await assert.rejects(db.query('UPDATE organization_members SET business_role=NULL WHERE organization_id=$1 AND user_id=$2', [org, explicit]), { code: '23502' })
    await db.query('ROLLBACK TO SAVEPOINT invalid_role')
  } finally { await db.query('ROLLBACK'); db.release(); await pool.end() }
})
