import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { LocalAuthSessionStore } from './session-store.js'

describe('LocalAuthSessionStore workspaces', () => {
  it('keeps test and production workspaces separate, and only allows test reset', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-workspaces-'))
    try {
      const store = new LocalAuthSessionStore(join(directory, 'auth.json'))
      const registered = await store.registerUser({ name: 'Test User', email: 'test@example.com', password: 'test-password-123', companyName: 'Registered Company' })
      const user = registered.user
      const testWorkspace = await store.createWorkspace(user.id, { name: 'Demo Company', kind: 'test' })
      const productionWorkspace = await store.createWorkspace(user.id, { name: 'Real Company', kind: 'production' })
      assert.equal((await store.listWorkspaces(user.id)).length, 3)
      const session = await store.createSession(user)
      await store.selectWorkspace(session.session.sessionId, user.id, testWorkspace.id)
      await store.resetWorkspace(user.id, testWorkspace.id)
      await assert.rejects(() => store.resetWorkspace(user.id, productionWorkspace.id), /只有测试企业可以重新开始/)
      await store.archiveWorkspace(user.id, testWorkspace.id)
      const archivedSession = await store.findSessionByToken(session.token)
      assert.equal(archivedSession?.user.workspaceId, undefined)
      const workspaces = await store.listWorkspaces(user.id)
      assert.deepEqual(workspaces.map((item) => item.id).sort(), [registered.workspace.id, productionWorkspace.id, testWorkspace.id].sort())
      assert.equal(workspaces.find((item) => item.id === testWorkspace.id)?.status, 'archived')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not expose another user workspace and only owners can archive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-workspaces-'))
    try {
      const store = new LocalAuthSessionStore(join(directory, 'auth.json'))
      const ownerRegistration = await store.registerUser({ name: 'Workspace Owner', email: 'owner@example.com', password: 'test-password-123', companyName: 'Owner Company' })
      const otherRegistration = await store.registerUser({ name: 'Other User', email: 'other@example.com', password: 'test-password-123', companyName: 'Other Company' })
      const owner = ownerRegistration.user
      const other = otherRegistration.user
      const workspace = await store.createWorkspace(owner.id, { name: 'Private Test', kind: 'test' })
      assert.deepEqual((await store.listWorkspaces(other.id)).map(item => item.id), [otherRegistration.workspace.id])
      await assert.rejects(() => store.archiveWorkspace(other.id, workspace.id), /无权操作该企业/)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('creates an owned trial enterprise during registration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-open-registration-'))
    try {
      const store = new LocalAuthSessionStore(join(directory, 'auth.json'))
      const result = await store.registerUser({
        name: '陈婉清',
        email: 'owner@example.com',
        password: 'test-password-123',
        companyName: '龙道科技',
        phone: '13800000000',
      })
      assert.equal(result.workspace.name, '龙道科技')
      assert.equal(result.workspace.role, 'owner')
      assert.equal(result.workspace.serviceStatus, 'trial')
      assert.ok(result.workspace.trialEndsAt)
      assert.deepEqual((await store.listWorkspaces(result.user.id)).map(item => item.role), ['owner'])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
