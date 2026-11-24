import type { DingTalkApprovalClient, DingTalkProcessInstance } from './approval-client.js'
import { DingTalkCallbackCrypto } from './callback-crypto.js'

export type DingTalkExternalApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface DingTalkApprovalRepository {
  getDepartmentPolicy(departmentId: string, subjectType: string): Promise<{ processCode: string; departmentExternalId: number } | undefined>
  attachExternalInstance(input: { internalInstanceId: string; processInstanceId: string }): Promise<void>
  cancelPendingStart(input: { internalInstanceId: string; reason: string }): Promise<void>
  applyDecision(input: { eventId: string; processInstanceId: string; decision: 'approved' | 'rejected'; approverUserId?: string; comment?: string; rawPayload: unknown }): Promise<{ replayed: boolean }>
  /** Optional for memory/test repositories; PostgreSQL records intermediate node history. */
  recordExternalProgress?(input: { eventId: string; processInstanceId: string; status: DingTalkExternalApprovalStatus; externalStepId?: string; nodeName?: string; approverUserId?: string; comment?: string; actedAt?: string; rawPayload: unknown }): Promise<{ replayed: boolean }>
  listPendingExternalApprovals?(): Promise<Array<{ processInstanceId: string }>>
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
  EventType?: unknown
  EventId?: unknown
  processInstanceId?: unknown
  processInstanceIdList?: unknown
  type?: unknown
  eventType?: unknown
  status?: unknown
  instanceStatus?: unknown
  processInstanceStatus?: unknown
  process_status?: unknown
  result?: unknown
  approvalResult?: unknown
  approveResult?: unknown
  finishTime?: unknown
  taskList?: unknown
  tasks?: unknown
  activityList?: unknown
  approverUserId?: unknown
  userId?: unknown
  comment?: unknown
  remark?: unknown
  nodeName?: unknown
  taskName?: unknown
  mode?: unknown
}

function optionalString(...values: unknown[]): string | undefined {
  const value = values.find((item) => typeof item === 'string' && item.trim())
  return typeof value === 'string' ? value.trim() : undefined
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value)
  if (!result) throw new DingTalkApprovalWorkflowError('DINGTALK_CALLBACK_INVALID', `${field} is required`)
  return result
}

function normalizeStatus(value: unknown): string | undefined {
  return optionalString(value)?.toLowerCase().replace(/[\s-]+/gu, '_')
}

function normalizeResult(value: unknown): 'approved' | 'rejected' | undefined {
  const result = normalizeStatus(value)
  if (!result) return undefined
  if (['agree', 'approved', 'approve', 'pass', 'passed', 'success'].includes(result)) return 'approved'
  if (['refuse', 'refused', 'rejected', 'reject', 'fail', 'failed', 'cancelled', 'canceled', 'terminated', 'terminate'].includes(result)) return 'rejected'
  return undefined
}

function isFinalStatus(status: string | undefined): boolean {
  return Boolean(status && ['completed', 'finished', 'approved', 'rejected', 'refused', 'cancelled', 'canceled', 'terminated', 'closed'].includes(status))
}

function externalStatus(status: string | undefined, decision: 'approved' | 'rejected' | undefined): DingTalkExternalApprovalStatus {
  if (decision) return decision
  return status && ['completed', 'finished', 'approved', 'rejected', 'refused', 'cancelled', 'canceled', 'terminated', 'closed'].includes(status) ? 'rejected' : 'pending'
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function dateValue(...values: unknown[]): string | undefined {
  const value = values.find((item) => (typeof item === 'string' && item.trim()) || typeof item === 'number')
  if (value === undefined || value === null) return undefined
  const textValue = typeof value === 'string' ? value.trim() : undefined
  const numeric = typeof value === 'number' ? value : textValue && /^\d{10,13}$/u.test(textValue) ? Number(textValue) : NaN
  const date = Number.isFinite(numeric) ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric) : new Date(String(value))
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

interface ExternalProgressNode {
  status: DingTalkExternalApprovalStatus
  externalStepId?: string
  nodeName?: string
  approverUserId?: string
  comment?: string
  actedAt?: string
}

function progressNodes(payload: CallbackPayload, _status: string | undefined, decision: 'approved' | 'rejected' | undefined): ExternalProgressNode[] {
  const list = [payload.taskList, payload.tasks, payload.activityList].find(Array.isArray) as unknown[] | undefined
  const source = list?.map(recordValue).filter((item): item is Record<string, unknown> => Boolean(item)) ?? []
  const items = source.length ? source : [payload as unknown as Record<string, unknown>]
  return items.map((item): ExternalProgressNode => {
    const itemStatus = normalizeStatus(item.status ?? item.taskStatus ?? item.processTaskStatus)
    const itemDecision = normalizeResult(item.result ?? item.approvalResult ?? item.approveResult ?? item.decision)
    const finalItem = itemDecision ?? normalizeResult(itemStatus) ?? (itemStatus && isFinalStatus(itemStatus) ? decision : undefined)
    const externalStepId = optionalString(item.taskId, item.activityId, item.nodeId, item.processTaskId, item.id)
    const nodeName = optionalString(item.nodeName, item.taskName, item.activityName, item.name)
    const approverUserId = optionalString(item.approverUserId, item.userId, item.actorUserId)
    const comment = optionalString(item.comment, item.remark, item.reason)
    const actedAt = dateValue(item.finishTime, item.finishedTime, item.completeTime, item.actionTime, item.actedAt)
    return {
      status: (finalItem ?? 'pending') as DingTalkExternalApprovalStatus,
      ...(externalStepId ? { externalStepId } : {}),
      ...(nodeName ? { nodeName } : {}),
      ...(approverUserId ? { approverUserId } : {}),
      ...(comment ? { comment } : {}),
      ...(actedAt ? { actedAt } : {}),
    }
  }).filter((item, index) => source.length || index === 0 || Boolean(item.externalStepId || item.nodeName || item.approverUserId))
}

function processIdFrom(payload: CallbackPayload): string {
  if (typeof payload.processInstanceId === 'string') return requiredString(payload.processInstanceId, 'processInstanceId')
  if (Array.isArray(payload.processInstanceIdList)) {
    const first = payload.processInstanceIdList.find((item): item is string => typeof item === 'string' && item.trim().length > 0)
    return requiredString(first, 'processInstanceId')
  }
  throw new DingTalkApprovalWorkflowError('DINGTALK_CALLBACK_INVALID', 'processInstanceId is required')
}

function payloadFromProcessInstance(instance: DingTalkProcessInstance): CallbackPayload {
  const raw = instance.raw && typeof instance.raw === 'object' ? instance.raw as Record<string, unknown> : {}
  return {
    ...raw,
    processInstanceId: instance.processInstanceId,
    status: instance.status ?? raw.status ?? raw.instanceStatus ?? raw.processInstanceStatus,
    instanceStatus: raw.instanceStatus,
    processInstanceStatus: raw.processInstanceStatus,
    result: instance.result ?? raw.result,
    finishTime: instance.finishTime ?? raw.finishTime,
  }
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
      const formValues = [
        ...input.formValues.filter((item) => item.name !== '需求部门'),
        { name: '需求部门', value: String(policy.departmentExternalId) },
      ]
      started = await this.client.startProcess({ processCode: policy.processCode, originatorUserId: input.originatorUserId, departmentId: policy.departmentExternalId, formValues })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'DingTalk approval start failed'
      await this.repository.cancelPendingStart({ internalInstanceId: input.internalInstanceId, reason })
      throw error
    }
    await this.repository.attachExternalInstance({ internalInstanceId: input.internalInstanceId, processInstanceId: started.processInstanceId })
    return { processInstanceId: started.processInstanceId, processCode: policy!.processCode }
  }

  async handleCallback(input: { body: string; timestamp: string; nonce: string; signature: string }, options: { verificationOnly?: boolean } = {}): Promise<{ status: DingTalkExternalApprovalStatus; replayed: boolean; response: ReturnType<DingTalkCallbackCrypto['encrypt']> }> {
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
    // DingTalk validates an HTTP callback URL by sending an encrypted check_url event.
    // It has no processInstanceId and must be acknowledged before approval-event parsing.
    const eventType = optionalString(payload.EventType, payload.eventType, payload.type)?.toLowerCase()
    if (eventType === 'check_url' || eventType === 'check_create_suite_url') {
      return { status: 'pending', replayed: false, response: this.callbackCrypto.encrypt('success', input.timestamp, input.nonce) }
    }
    if (options.verificationOnly) throw new DingTalkApprovalWorkflowError('DINGTALK_CALLBACK_VERIFICATION_ONLY', '模拟模式只接受钉钉回调地址验证，不处理真实审批事件', 403)
    const processInstanceId = processIdFrom(payload)
    return this.applyExternalPayload(payload, processInstanceId, input.timestamp, input.nonce)
  }

  /** 查询所有仍在本地 pending 的钉钉审批，补偿掉线或漏投递的回调。 */
  /** 仅供本地模拟模式推进审批；最终落库复用真实回调的同步逻辑。 */
  async applyMockDecision(input: { processInstanceId: string; decision: 'approved' | 'rejected'; comment?: string }): Promise<{ status: DingTalkExternalApprovalStatus; replayed: boolean }> {
    const timestamp = String(this.now())
    const payload: CallbackPayload = {
      processInstanceId: input.processInstanceId,
      status: 'COMPLETED',
      result: input.decision,
      finishTime: timestamp,
      ...(input.comment ? { comment: input.comment } : {}),
      mode: 'mock',
    }
    const result = await this.applyExternalPayload(payload, input.processInstanceId, timestamp, 'mock', `mock:${input.processInstanceId}:${input.decision}`)
    return { status: result.status, replayed: result.replayed }
  }

  async reconcilePending(): Promise<{ checked: number; completed: number; pending: number }> {
    const list = await this.repository.listPendingExternalApprovals?.() ?? []
    if (!this.client.getProcessInstance) return { checked: 0, completed: 0, pending: list.length }
    let completed = 0
    for (const item of list) {
      try {
        const instance = await this.client.getProcessInstance(item.processInstanceId)
        const payload = payloadFromProcessInstance(instance)
        const result = normalizeResult(payload.result)
        const status = normalizeStatus(payload.status ?? payload.instanceStatus ?? payload.processInstanceStatus ?? payload.process_status)
        if (!isFinalStatus(status) && !result) continue
        const eventId = optionalString(payload.eventId, payload.EventId) ?? `dingtalk:${item.processInstanceId}:finished:${String(payload.finishTime ?? status ?? result ?? 'unknown')}`
        await this.applyExternalPayload(payload, item.processInstanceId, String(this.now()), 'reconcile', eventId)
        completed += 1
      } catch {
        // A transient failure for one instance must not stop the remaining reconciliation batch.
      }
    }
    return { checked: list.length, completed, pending: list.length - completed }
  }

  async assertLocalDecisionAllowed(subjectType: string, subjectId: string): Promise<void> {
    if (await this.repository.hasActiveExternalApproval(subjectType, subjectId)) {
      throw new DingTalkApprovalWorkflowError('DINGTALK_APPROVAL_ACTIVE', '该事项正在钉钉审批，必须由钉钉审批回调更新结果', 409)
    }
  }

  private async applyExternalPayload(payload: CallbackPayload, processInstanceId: string, timestamp: string, nonce: string, explicitEventId?: string): Promise<{ status: DingTalkExternalApprovalStatus; replayed: boolean; response: ReturnType<DingTalkCallbackCrypto['encrypt']> }> {
    const status = normalizeStatus(payload.status ?? payload.instanceStatus ?? payload.processInstanceStatus ?? payload.process_status)
    const decision = normalizeResult(payload.result ?? payload.approvalResult ?? payload.approveResult) ?? normalizeResult(status)
    const final = isFinalStatus(status) || Boolean(decision)
    const eventId = explicitEventId ?? optionalString(payload.eventId, payload.EventId) ?? `${optionalString(payload.type, payload.eventType) ?? 'approval'}:${processInstanceId}:${String(payload.finishTime ?? status ?? payload.result ?? '')}`
    const progressStatus = externalStatus(status, decision)
    const nodes = progressNodes(payload, status, decision)

    if (!final) {
      let replayed = true
      for (const [index, node] of nodes.entries()) {
        const progress = await this.repository.recordExternalProgress?.({ eventId: nodes.length === 1 && !node.externalStepId && !node.nodeName ? eventId : `${eventId}:node:${node.externalStepId ?? index}`, processInstanceId, ...node, rawPayload: payload })
        replayed = replayed && (progress?.replayed ?? false)
      }
      return { status: progressStatus, replayed, response: this.callbackCrypto.encrypt('success', timestamp, nonce) }
    }
    if (!decision) {
      throw new DingTalkApprovalWorkflowError('DINGTALK_CALLBACK_INVALID', `审批已结束但缺少最终结果：${status ?? 'unknown'}`, 422)
    }
    for (const [index, node] of nodes.entries()) {
      await this.repository.recordExternalProgress?.({ eventId: `${eventId}:node:${node.externalStepId ?? index}`, processInstanceId, ...node, rawPayload: payload })
    }
    const topNode = nodes[0]
    const applied = await this.repository.applyDecision({ eventId, processInstanceId, decision, ...(topNode?.approverUserId ? { approverUserId: topNode.approverUserId } : {}), ...(topNode?.comment ? { comment: topNode.comment } : {}), rawPayload: payload })
    return { status: decision, replayed: applied.replayed, response: this.callbackCrypto.encrypt('success', timestamp, nonce) }
  }

  private verifyCallback(input: { timestamp: string; nonce: string; signature: string }, encrypted: string): void {
    const numeric = Number(input.timestamp)
    const timestampMs = numeric < 10_000_000_000 ? numeric * 1000 : numeric
    if (!Number.isFinite(timestampMs) || Math.abs(this.now() - timestampMs) > this.callbackMaxAgeMs) throw new DingTalkApprovalWorkflowError('DINGTALK_CALLBACK_EXPIRED', '钉钉审批回调已过期', 401)
    if (!this.callbackCrypto.verify(input.signature, input.timestamp, input.nonce, encrypted)) throw new DingTalkApprovalWorkflowError('DINGTALK_CALLBACK_UNAUTHORIZED', '钉钉审批回调签名无效', 401)
  }
}

