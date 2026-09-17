import type { DingTalkApprovalClient } from './approval-client.js'
import { DingTalkCallbackCrypto } from './callback-crypto.js'

export interface DingTalkApprovalRepository {
  getDepartmentPolicy(departmentId: string, subjectType: string): Promise<{ processCode: string; departmentExternalId: number } | undefined>
  attachExternalInstance(input: { internalInstanceId: string; processInstanceId: string }): Promise<void>
  cancelPendingStart(input: { internalInstanceId: string; reason: string }): Promise<void>
  applyDecision(input: { eventId: string; processInstanceId: string; decision: 'approved' | 'rejected'; approverUserId?: string; comment?: string; rawPayload: unknown }): Promise<{ replayed: boolean }>
  hasActiveExternalApproval(subjectType: string, subjectId: string): Promise<boolean>
}

export class DingTalkApprovalWorkflowError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message) }
}

export interface DingTalkApprovalWorkflowOptions {
  callbackToken: string
  callbackAesKey: string
  callbackCorpId: string
  callbackMaxAgeMs?: number
  now?: () => number
}

interface CallbackPayload {
  eventId?: unknown
  EventId?: unknown
  processInstanceId?: unknown
  processInstanceIdList?: unknown
  type?: unknown
  result?: unknown
  finishTime?: unknown
  approverUserId?: unknown
  comment?: unknown
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DingTalkApprovalWorkflowError('DINGTALK_CALLBACK_INVALID', `${field} is required`)
  return value.trim()
}

export class DingTalkApprovalWorkflow {
  private readonly now: () => number
  private readonly callbackMaxAgeMs: number
  private readonly callbackCrypto: DingTalkCallbackCrypto

  constructor(
    private readonly repository: DingTalkApprovalRepository,
    private readonly client: DingTalkApprovalClient,
    private readonly options: DingTalkApprovalWorkflowOptions,
  ) {
    this.callbackCrypto = new DingTalkCallbackCrypto({ token: options.callbackToken, aesKey: options.callbackAesKey, corpId: options.callbackCorpId })
    this.now = options.now ?? Date.now
    this.callbackMaxAgeMs = options.callbackMaxAgeMs ?? 5 * 60 * 1000
  }

  async start(input: { internalInstanceId: string; departmentId: string; subjectType?: string; originatorUserId: string; formValues: Array<{ name: string; value: string }> }) {
    const subjectType = input.subjectType ?? 'recruitment_request'
    let policy: Awaited<ReturnType<DingTalkApprovalRepository['getDepartmentPolicy']>>
    let started: Awaited<ReturnType<DingTalkApprovalClient['startProcess']>>
    try {
      policy = await this.repository.getDepartmentPolicy(input.departmentId, subjectType)
      if (!policy) throw new DingTalkApprovalWorkflowError('DINGTALK_APPROVAL_POLICY_MISSING', '该部门尚未配置钉钉审批流程', 409)
      started = await this.client.startProcess({
        processCode: policy.processCode,
        originatorUserId: input.originatorUserId,
        departmentId: policy.departmentExternalId,
        formValues: input.formValues,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'DingTalk approval start failed'
      await this.repository.cancelPendingStart({ internalInstanceId: input.internalInstanceId, reason })
      throw error
    }
    await this.repository.attachExternalInstance({ internalInstanceId: input.internalInstanceId, processInstanceId: started.processInstanceId })
    return { processInstanceId: started.processInstanceId, processCode: policy!.processCode }
  }

  async handleCallback(input: { body: string; timestamp: string; nonce: string; signature: string }): Promise<{ status: 'approved' | 'rejected'; replayed: boolean; response: ReturnType<DingTalkCallbackCrypto['encrypt']> }> {
    let payload: CallbackPayload
    try {
      const envelope = JSON.parse(input.body) as { encrypt?: unknown }
      const encrypted = requiredString(envelope.encrypt, 'encrypt')
      this.verifyCallback(input, encrypted)
      payload = JSON.parse(this.callbackCrypto.decrypt(encrypted)) as CallbackPayload
    } catch (error) {
      if (error instanceof DingTalkApprovalWorkflowError) throw error
      throw new DingTalkApprovalWorkflowError('DINGTALK_CALLBACK_UNAUTHORIZED', '钉钉审批回调验签或解密失败', 401)
    }
    const processInstanceId = typeof payload.processInstanceId === 'string'
      ? requiredString(payload.processInstanceId, 'processInstanceId')
      : Array.isArray(payload.processInstanceIdList) ? requiredString(payload.processInstanceIdList[0], 'processInstanceId') : requiredString(undefined, 'processInstanceId')
    const eventId = typeof payload.eventId === 'string' || typeof payload.EventId === 'string'
      ? requiredString(payload.eventId ?? payload.EventId, 'eventId')
      : `${requiredString(payload.type, 'type')}:${processInstanceId}:${String(payload.finishTime ?? '')}`
    const result = requiredString(payload.result, 'result').toLowerCase()
    const decision = ['agree', 'approved', 'approve'].includes(result) ? 'approved' : ['refuse', 'rejected', 'reject'].includes(result) ? 'rejected' : undefined
    if (!decision) throw new DingTalkApprovalWorkflowError('DINGTALK_CALLBACK_IGNORED', `不支持的审批结果：${result}`, 422)
    const applied = await this.repository.applyDecision({
      eventId,
      processInstanceId,
      decision,
      ...(typeof payload.approverUserId === 'string' ? { approverUserId: payload.approverUserId } : {}),
      ...(typeof payload.comment === 'string' ? { comment: payload.comment } : {}),
      rawPayload: payload,
    })
    return { status: decision, replayed: applied.replayed, response: this.callbackCrypto.encrypt('success', input.timestamp, input.nonce) }
  }

  async assertLocalDecisionAllowed(subjectType: string, subjectId: string): Promise<void> {
    if (await this.repository.hasActiveExternalApproval(subjectType, subjectId)) {
      throw new DingTalkApprovalWorkflowError('DINGTALK_APPROVAL_ACTIVE', '该事项正在钉钉审批，必须由钉钉审批回调更新结果', 409)
    }
  }

  private verifyCallback(input: { timestamp: string; nonce: string; signature: string }, encrypted: string): void {
    const numeric = Number(input.timestamp)
    const timestampMs = numeric < 10_000_000_000 ? numeric * 1000 : numeric
    if (!Number.isFinite(timestampMs) || Math.abs(this.now() - timestampMs) > this.callbackMaxAgeMs) {
      throw new DingTalkApprovalWorkflowError('DINGTALK_CALLBACK_EXPIRED', '钉钉审批回调已过期', 401)
    }
    if (!this.callbackCrypto.verify(input.signature, input.timestamp, input.nonce, encrypted)) {
      throw new DingTalkApprovalWorkflowError('DINGTALK_CALLBACK_UNAUTHORIZED', '钉钉审批回调签名无效', 401)
    }
  }
}
