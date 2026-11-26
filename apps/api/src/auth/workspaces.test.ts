import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { LocalAuthSessionStore } from './session-store.js'

describe('LocalAuthSessionStore workspaces', () => {
  it('allows an unbound account to create exactly one enterprise, including after archive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-workspaces-'))
    try {
      const store = new LocalAuthSessionStore(join(directory,'auth.json'))
      const registered = await store.registerUser({name:'Test User',email:'test@example.com',password:'test-password-123'})
      assert.equal(registered.workspace,undefined)
      assert.equal((await store.listWorkspaces(registered.user.id)).length,0)
      const workspace = await store.createWorkspace(registered.user.id,{name:'Demo Company',kind:'test'})
      await assert.rejects(store.createWorkspace(registered.user.id,{name:'Second Company',kind:'production'}),{code:'ACCOUNT_ALREADY_BOUND'})
      await store.resetWorkspace(registered.user.id,workspace.id)
      await store.archiveWorkspace(registered.user.id,workspace.id)
      await assert.rejects(store.createWorkspace(registered.user.id,{name:'Archive bypass',kind:'production'}),{code:'ACCOUNT_ALREADY_BOUND'})
      assert.equal((await store.listWorkspaces(registered.user.id)).length,1)
    } finally { await rm(directory,{recursive:true,force:true}) }
  })

  it('does not expose another user workspace and only owners can archive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-workspaces-'))
    try {
      const store = new LocalAuthSessionStore(join(directory, 'auth.json'))
      const ownerRegistration = await store.registerUser({ name: 'Workspace Owner', email: 'owner@example.com', password: 'test-password-123', companyName: 'Owner Company' })
      const otherRegistration = await store.registerUser({ name: 'Other User', email: 'other@example.com', password: 'test-password-123', companyName: 'Other Company' })
      const owner = ownerRegistration.user
      const other = otherRegistration.user
      const workspace = ownerRegistration.workspace!
      assert.deepEqual((await store.listWorkspaces(other.id)).map(item => item.id), [otherRegistration.workspace!.id])
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
      assert.equal(result.workspace!.name, '龙道科技')
      assert.equal(result.workspace!.role, 'owner')
      assert.equal(result.workspace!.serviceStatus, 'trial')
      assert.ok(result.workspace!.trialEndsAt)
      assert.deepEqual((await store.listWorkspaces(result.user.id)).map(item => item.role), ['owner'])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
