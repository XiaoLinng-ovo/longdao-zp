import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SessionUser } from './types.js'
import { PostgresSessionRepository } from './session-repository.js'

class FakePool {
  calls: Array<{ sql: string; values: unknown[] }> = []
  responses: unknown[]
  constructor(responses: unknown[] = []) { this.responses = responses }
  async query<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values })
    return { rows: (this.responses.shift() ?? []) as T[] }
  }
}

const user: SessionUser = { id: '11111111-1111-4111-8111-111111111111', name: 'Admin', email: 'admin@example.com', role: 'admin', departmentId: '22222222-2222-4222-8222-222222222222' }

describe('PostgresSessionRepository', () => {
  it('creates a session with hashed token and parameterized SQL', async () => {
    const pool = new FakePool([[{ id: '33333333-3333-4333-8333-333333333333', user_id: user.id, token_hash: 'hash', csrf_token_hash: 'csrf', created_at: new Date(), expires_at: new Date(Date.now() + 1000), last_seen_at: new Date() }]])
    const repository = new PostgresSessionRepository(pool)
    const result = await repository.createSession(user, 1000)
    assert.ok(result.token)
    assert.equal(result.session.userId, user.id)
    assert.match(pool.calls[0]!.sql, /INSERT INTO sessions/i)
    assert.equal(pool.calls[0]!.values.length, 8)
    assert.ok(!pool.calls[0]!.sql.includes(result.token))
  })

  it('finds a non-expired session by token hash and touches last_seen_at', async () => {
    const row = { id: '33333333-3333-4333-8333-333333333333', user_id: user.id, token_hash: 'x', created_at: new Date(), expires_at: new Date(Date.now() + 100000), last_seen_at: new Date(), name: user.name, email: user.email, role: user.role, department_id: user.departmentId }
    const pool = new FakePool([[row], []])
    const repository = new PostgresSessionRepository(pool)
    const session = await repository.findSessionByToken('secret')
    assert.equal(session?.sessionId, row.id)
    assert.match(pool.calls[0]!.sql, /token_hash\s*=\s*\$1/i)
    assert.match(pool.calls[0]!.sql, /u\.is_active\s*=\s*true/i)
    assert.match(pool.calls[1]!.sql, /UPDATE sessions SET last_seen_at/i)
  })

  it('revokes sessions and removes expired or revoked rows', async () => {
    const pool = new FakePool([[], [{ count: '3' }]])
    const repository = new PostgresSessionRepository(pool)
    await repository.revokeSession('33333333-3333-4333-8333-333333333333')
    const removed = await repository.cleanupExpiredSessions()
    assert.equal(removed, 3)
    assert.match(pool.calls[0]!.sql, /UPDATE sessions SET revoked_at/i)
    assert.match(pool.calls[1]!.sql, /DELETE FROM sessions/i)
  })
})

it('loads a user by email and verifies a database password hash', async () => {
  const { hashPassword } = await import('./password.js')
  const passwordHash = await hashPassword('secret')
  const pool = new FakePool([[{ id: user.id, display_name: user.name, email: user.email, password_hash: passwordHash, department_id: user.departmentId, role: user.role }]])
  const repository = new PostgresSessionRepository(pool)
  const found = await repository.findUserByEmailPassword(user.email, 'secret')
  assert.deepEqual(found, { ...user, role: 'recruiter' })
  assert.match(pool.calls[0]!.sql, /FROM users/i)
})

it('exposes a unified auth session store factory for postgres environments', async () => {
  const { createAuthSessionStore } = await import('./auth-service.js')
  const store = createAuthSessionStore({ DATABASE_URL: 'postgres://localhost/smartrecruit', NODE_ENV: 'production' })
  assert.equal(store.constructor.name, 'PostgresSessionRepository')
})

it('uses PostgreSQL sessions in development when database credentials are configured', async () => {
  const { createAuthSessionStore } = await import('./auth-service.js')
  const store = createAuthSessionStore({ PGPASSWORD: 'development-password', NODE_ENV: 'development' })
  assert.equal(store.constructor.name, 'PostgresSessionRepository')
})

it('refuses local session fallback in production without database configuration', async () => {
  const { createAuthSessionStore } = await import('./auth-service.js')
  assert.throws(() => createAuthSessionStore({ NODE_ENV: 'production' }), /database configuration/i)
})

for(const revoked of [false,true]) it('invited registration stays in one transaction, no company provision; revoked='+revoked,async()=>{
 const workspaceId='22222222-2222-4222-8222-222222222222',invitationId='33333333-3333-4333-8333-333333333333'
 const calls:string[]=[]
 const now=new Date(),future=new Date(Date.now()+600000)
 const invitation={id:invitationId,organization_id:workspaceId,workspace_name:'受邀企业',workspace_kind:'test',workspace_status:'active',service_available:true,is_shared:true,expires_at:future,...(revoked?{revoked_at:now}:{})}
 const query=async<T extends Record<string,unknown>>(sql:string):Promise<{rows:T[]}>=>{
  calls.push(sql)
  let rows:Record<string,unknown>[]=[]
  if(sql.includes('SELECT * FROM email_verification_challenges')) rows=[{id:'challenge',expires_at:future,code_hash:'a'.repeat(64),attempts:0,max_attempts:5}]
  else if(sql.includes('INSERT INTO users')) rows=[{id:user.id,email:'invited@example.com',display_name:'受邀成员'}]
  else if(sql.includes('FROM organization_invitations i')) rows=[invitation]
  else if(sql.startsWith('SELECT * FROM organizations')) rows=[{id:workspaceId,name:'受邀企业',kind:'test',status:'active',created_at:now,service_status:'trial'}]
  else if(sql.startsWith('SELECT id FROM users')) rows=[{id:user.id}]
  else if(sql.includes('FROM public.organization_schemas')) rows=[{schema_name:'company_'+workspaceId.replaceAll('-',''),status:'ready',structure_ready:true}]
  return {rows:rows as T[]}
 }
 const db={query,async connect(){return {query,release(){calls.push('RELEASE')}}}}
 const repository=new PostgresSessionRepository(db)
 const registration=repository.registerUserWithVerification({name:'受邀成员',email:'invited@example.com',password:'strong-password',companyName:'',invitationCode:'ABCDEF123456ABCDEF123456'},{codeHash:'a'.repeat(64)})
 if(revoked) {
  await assert.rejects(registration,{code:'INVITATION_REVOKED'})
  assert.ok(calls.includes('ROLLBACK'));assert.ok(!calls.includes('COMMIT'))
 } else {
  const result=await registration
  assert.equal(result.workspace.id,workspaceId);assert.equal(result.workspace.role,'member')
  assert.ok(calls.includes('COMMIT'))
  assert.ok(calls.findIndex(sql=>sql.includes('INSERT INTO organization_invitation_joins'))<calls.indexOf('COMMIT'))
 }
 assert.ok(!calls.some(sql=>sql.includes('INSERT INTO organizations')||sql.includes('initialize_organization_schema')))
 assert.ok(calls.findIndex(sql=>sql.includes('SET consumed_at'))<calls.findIndex(sql=>sql.includes('INSERT INTO users')))
 assert.equal(calls.at(-1),'RELEASE')
})
