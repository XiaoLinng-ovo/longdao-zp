import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DingTalkApprovalClient } from './approval-client.js'
import { DingTalkApprovalWorkflow, DingTalkApprovalWorkflowError, type DingTalkApprovalRepository } from './approval-workflow.js'
import { DingTalkCallbackCrypto } from './callback-crypto.js'

const callbackConfig = { callbackToken: 'token', callbackAesKey: Buffer.alloc(32, 7).toString('base64').replace(/=$/u, ''), callbackCorpId: 'corp-1' }

function hasCode(error: unknown, code: string): boolean {
  return error instanceof DingTalkApprovalWorkflowError && error.code === code
}

class MemoryRepository implements DingTalkApprovalRepository {
  policy = { processCode: 'PROC-TECH', departmentExternalId: 42 }
  instances = new Map<string, { internalInstanceId: string; status: 'pending' | 'approved' | 'rejected' }>()
  events = new Set<string>()
  async getDepartmentPolicy() { return this.policy }
  async attachExternalInstance(input: { internalInstanceId: string; processInstanceId: string }) {
    this.instances.set(input.processInstanceId, { internalInstanceId: input.internalInstanceId, status: 'pending' })
  }
  async cancelPendingStart(_input: { internalInstanceId: string; reason: string }): Promise<void> { return undefined }
  async applyDecision(input: { eventId: string; processInstanceId: string; decision: 'approved' | 'rejected' }) {
    if (this.events.has(input.eventId)) return { replayed: true as const }
    this.events.add(input.eventId)
    const instance = this.instances.get(input.processInstanceId)
    if (!instance) throw new Error('missing instance')
    instance.status = input.decision
    return { replayed: false as const }
  }
  async hasActiveExternalApproval(subjectType: string, subjectId: string) {
    return subjectType === 'recruitment_request' && subjectId === 'request-1'
  }
}

describe('DingTalkApprovalWorkflow', () => {
  it('starts the department workflow and persists its process instance id', async () => {
    const repository = new MemoryRepository()
    const calls: unknown[] = []
    const client: DingTalkApprovalClient = { async startProcess(input) { calls.push(input); return { processInstanceId: 'ding-process-1' } } }
    const workflow = new DingTalkApprovalWorkflow(repository, client, callbackConfig)

    const result = await workflow.start({ internalInstanceId: 'internal-1', departmentId: 'dept-1', originatorUserId: 'ding-user-1', formValues: [{ name: '岗位', value: '后端工程师' }] })

    assert.deepEqual(result, { processInstanceId: 'ding-process-1', processCode: 'PROC-TECH' })
    assert.deepEqual(calls, [{
      processCode: 'PROC-TECH',
      originatorUserId: 'ding-user-1',
      departmentId: 42,
      formValues: [
        { name: '岗位', value: '后端工程师' },
        { name: '需求部门', value: '42' },
      ],
    }])
    assert.equal(repository.instances.get('ding-process-1')?.internalInstanceId, 'internal-1')
  })

  it('cancels the pending local instance when DingTalk start fails', async () => {
    const cancelled: Array<{ internalInstanceId: string; reason: string }> = []
    const repository = new MemoryRepository()
    repository.cancelPendingStart = async (input) => { cancelled.push(input) }
    const workflow = new DingTalkApprovalWorkflow(repository, { startProcess: async () => { throw new Error('DingTalk unavailable') } }, callbackConfig)

    await assert.rejects(workflow.start({ internalInstanceId: 'local-1', departmentId: 'dept-1', originatorUserId: 'user-1', formValues: [] }), /DingTalk unavailable/)
    assert.deepEqual(cancelled, [{ internalInstanceId: 'local-1', reason: 'DingTalk unavailable' }])
  })

  it('cancels the pending local instance when the department policy is missing', async () => {
    const cancelled: Array<{ internalInstanceId: string; reason: string }> = []
    const repository = new MemoryRepository()
    repository.policy = undefined as never
    repository.cancelPendingStart = async (input) => { cancelled.push(input) }
    const workflow = new DingTalkApprovalWorkflow(repository, { startProcess: async () => ({ processInstanceId: 'unused' }) }, callbackConfig)

    await assert.rejects(workflow.start({ internalInstanceId: 'local-1', departmentId: 'dept-1', originatorUserId: 'user-1', formValues: [] }), (error: unknown) => hasCode(error, 'DINGTALK_APPROVAL_POLICY_MISSING'))
    assert.equal(cancelled.length, 1)
  })

  it('verifies signed callbacks and applies a decision only once', async () => {
    const repository = new MemoryRepository()
    repository.instances.set('ding-process-1', { internalInstanceId: 'internal-1', status: 'pending' })
    const workflow = new DingTalkApprovalWorkflow(repository, { startProcess: async () => ({ processInstanceId: '' }) }, { ...callbackConfig, now: () => 1_000_000 })
    const crypto = new DingTalkCallbackCrypto({ token: callbackConfig.callbackToken, aesKey: callbackConfig.callbackAesKey, corpId: callbackConfig.callbackCorpId })
    const timestamp = '1000'
    const nonce = 'nonce-1'
    const envelope = crypto.encrypt(JSON.stringify({ eventId: 'event-1', processInstanceId: 'ding-process-1', result: 'agree', approverUserId: 'manager-1', comment: '同意' }), timestamp, nonce)
    const body = JSON.stringify({ encrypt: envelope.encrypt })

    const first = await workflow.handleCallback({ body, timestamp, nonce, signature: envelope.msg_signature })
    const replay = await workflow.handleCallback({ body, timestamp, nonce, signature: envelope.msg_signature })
    assert.deepEqual({ status: first.status, replayed: first.replayed }, { status: 'approved', replayed: false })
    assert.deepEqual({ status: replay.status, replayed: replay.replayed }, { status: 'approved', replayed: true })
    assert.equal(crypto.decrypt(first.response.encrypt), 'success')
    assert.equal(repository.instances.get('ding-process-1')?.status, 'approved')
  })

  it('acknowledges DingTalk HTTP callback URL verification without an approval instance id', async () => {
    const workflow = new DingTalkApprovalWorkflow(new MemoryRepository(), { startProcess: async () => ({ processInstanceId: '' }) }, { ...callbackConfig, now: () => 1_000_000 })
    const crypto = new DingTalkCallbackCrypto({ token: callbackConfig.callbackToken, aesKey: callbackConfig.callbackAesKey, corpId: callbackConfig.callbackCorpId })
    const timestamp = '1000'
    const nonce = 'url-check'
    const event = crypto.encrypt(JSON.stringify({ EventType: 'check_url' }), timestamp, nonce)

    const result = await workflow.handleCallback({ body: JSON.stringify({ encrypt: event.encrypt }), timestamp, nonce, signature: event.msg_signature })

    assert.equal(crypto.decrypt(result.response.encrypt), 'success')
    assert.equal(crypto.verify(result.response.msg_signature, result.response.timeStamp, result.response.nonce, result.response.encrypt), true)
  })

  it('does not process approval events when running callback verification-only mode', async () => {
    const workflow = new DingTalkApprovalWorkflow(new MemoryRepository(), { startProcess: async () => ({ processInstanceId: '' }) }, { ...callbackConfig, now: () => 1_000_000 })
    const crypto = new DingTalkCallbackCrypto({ token: callbackConfig.callbackToken, aesKey: callbackConfig.callbackAesKey, corpId: callbackConfig.callbackCorpId })
    const timestamp = '1000'
    const nonce = 'verification-only'
    const event = crypto.encrypt(JSON.stringify({ EventType: 'bpms_instance_change', processInstanceId: 'real-instance', status: 'COMPLETED', result: 'agree' }), timestamp, nonce)

    await assert.rejects(
      workflow.handleCallback({ body: JSON.stringify({ encrypt: event.encrypt }), timestamp, nonce, signature: event.msg_signature }, { verificationOnly: true }),
      (error: unknown) => hasCode(error, 'DINGTALK_CALLBACK_VERIFICATION_ONLY'),
    )
  })

  it('rejects invalid callback signatures and stale timestamps', async () => {
    const workflow = new DingTalkApprovalWorkflow(new MemoryRepository(), { startProcess: async () => ({ processInstanceId: '' }) }, { ...callbackConfig, now: () => 1_000_000 })
    const crypto = new DingTalkCallbackCrypto({ token: callbackConfig.callbackToken, aesKey: callbackConfig.callbackAesKey, corpId: callbackConfig.callbackCorpId })
    const valid = crypto.encrypt(JSON.stringify({ eventId: 'event-1', processInstanceId: 'ding-process-1', result: 'agree' }), '1000', 'nonce')
    const body = JSON.stringify({ encrypt: valid.encrypt })
    await assert.rejects(workflow.handleCallback({ body, timestamp: '1000', nonce: 'nonce', signature: 'bad' }), (error: unknown) => hasCode(error, 'DINGTALK_CALLBACK_UNAUTHORIZED'))
    const oldTimestamp = '1'
    const old = crypto.encrypt(JSON.stringify({ eventId: 'event-1', processInstanceId: 'ding-process-1', result: 'agree' }), oldTimestamp, 'nonce')
    await assert.rejects(workflow.handleCallback({ body: JSON.stringify({ encrypt: old.encrypt }), timestamp: oldTimestamp, nonce: 'nonce', signature: old.msg_signature }), (error: unknown) => hasCode(error, 'DINGTALK_CALLBACK_EXPIRED'))
  })

  it('blocks local decisions while a DingTalk approval is active', async () => {
    const workflow = new DingTalkApprovalWorkflow(new MemoryRepository(), { startProcess: async () => ({ processInstanceId: '' }) }, callbackConfig)
    await assert.rejects(workflow.assertLocalDecisionAllowed('recruitment_request', 'request-1'), (error: unknown) => hasCode(error, 'DINGTALK_APPROVAL_ACTIVE'))
  })
})
