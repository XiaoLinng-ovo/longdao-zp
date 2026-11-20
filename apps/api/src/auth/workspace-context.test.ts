import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import { compose, type Middleware, type RequestContext } from '../http.js'
import { loadConfig } from '../config.js'
import { errorMiddleware } from '../error-middleware.js'
import { requestIdMiddleware } from '../middleware.js'
import { sendSuccess } from '../response.js'
import { createIdempotencyMiddleware } from '../idempotency.js'
import { createWorkspaceContextMiddleware, isWorkspaceScopedPath } from './workspace-context.js'
import { currentTenantContext, organizationSchemaName } from '../db/tenant-context.js'

let server: Server
let base: string
const companyA = '11111111-1111-4111-8111-111111111111'
const companyB = '22222222-2222-4222-8222-222222222222'
let workspace: string | undefined = companyA
let role: 'recruiter' | 'interviewer' = 'recruiter'
let executions = 0
const auth: Middleware = async (context, next) => {
  context.auth = { sessionId: 'session', method: 'session', user: { id: 'user', name: 'test', email: 'test@example.invalid', role, departmentId: 'dept', ...(workspace ? { workspaceId: workspace } : {}) } }
  await next()
}
before(async () => {
  const schemas = {
    async query<T>(text: string, values?: unknown[]) {
      assert.match(text, /organization_schema_structure_ready/)
      const organizationId = values?.[0]
      assert.ok(organizationId === companyA || organizationId === companyB)
      return { rows: [{ schema_name: organizationSchemaName(organizationId), status: 'ready', structure_ready: true }] as T[] }
    },
  }
  const pipeline = compose([errorMiddleware, requestIdMiddleware, auth, createWorkspaceContextMiddleware(true, schemas, true), createIdempotencyMiddleware(), async (context) => {
    assert.deepEqual(currentTenantContext(), isWorkspaceScopedPath(context.url.pathname) && workspace
      ? { organizationId: workspace, schemaName: organizationSchemaName(workspace) } : undefined)
    executions += 1
    sendSuccess(context, { workspace, executions })
  }])
  server = createServer((req, res) => {
    const context = { req, res, config: loadConfig(), requestId: '', auth: undefined, url: new URL(req.url!, 'http://localhost') } as RequestContext
    void pipeline(context, async () => undefined)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  base = `http://127.0.0.1:${address.port}`
})
after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })

const request = (headers: Record<string, string> = {}, path = '/api/v1/jobs') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })
test('workspace context is checked before replay; missing/stale headers cannot execute or replay', async () => {
  workspace = companyA; role = 'recruiter'
  const headers = { 'x-workspace-id': companyA, 'idempotency-key': 'context-test-0001' }
  const first = await request(headers)
  assert.equal(first.status, 200)
  assert.match(first.headers.get('cache-control') ?? '', /no-store/)
  assert.match(first.headers.get('vary') ?? '', /X-Workspace-Id/)
  const original = await first.json()
  const replay = await request(headers)
  assert.equal(replay.headers.get('idempotency-replay'), 'true')
  assert.deepEqual((await replay.json()).data, original.data)
  const count = executions
  workspace = companyB
  const stale = await request(headers)
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).error.code, 'WORKSPACE_CONTEXT_CHANGED')
  const missing = await request({ 'idempotency-key': headers['idempotency-key'] })
  assert.equal((await missing.json()).error.code, 'WORKSPACE_CONTEXT_REQUIRED')
  assert.equal(executions, count)
  const second = await request({ ...headers, 'x-workspace-id': companyB })
  assert.equal(second.status, 200)
  assert.equal(second.headers.get('idempotency-replay'), null)
  assert.equal((await second.json()).data.workspace, companyB)
  role = 'interviewer'
  const changedRole = await request({ ...headers, 'x-workspace-id': companyB })
  assert.equal((await changedRole.json()).error.code, 'IDEMPOTENCY_KEY_REUSED')
})
test('all live/file/report/template APIs fail closed without an active workspace; bearer cannot select tenant via header', async () => {
  for (const path of ['/api/v1/interview-live-sessions/id/end', '/api/v1/resumes/id/download', '/api/v1/reports/funnel', '/api/v1/interviewer-options', '/api/v1/offer-templates']) {
    assert.equal(isWorkspaceScopedPath(path), true)
    workspace = undefined
    const empty = await request({ authorization: 'Bearer test' }, path)
    assert.equal((await empty.json()).error.code, 'WORKSPACE_REQUIRED')
    workspace = companyA
    const spoof = await request({ authorization: 'Bearer test', 'x-workspace-id': companyB }, path)
    assert.equal((await spoof.json()).error.code, 'WORKSPACE_CONTEXT_CHANGED')
  }
})
test('explicit workspace-selection endpoints do not require the old workspace or replay stale switch responses', async () => {
  workspace = undefined
  const path = '/api/v1/workspaces/' + companyA + '/select'
  assert.equal(isWorkspaceScopedPath(path), false)
  const headers = { 'idempotency-key': 'switch-test-0001' }
  const count = executions
  assert.equal((await request(headers, path)).status, 200)
  assert.equal((await request(headers, path)).headers.get('idempotency-replay'), null)
  assert.equal(executions, count + 2)
})
