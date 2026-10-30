import { randomUUID } from 'node:crypto'
import type { DingTalkApprovalClient, DingTalkApprovalInput, DingTalkProcessInstance } from './approval-client.js'

interface MockApprovalRecord {
  processInstanceId: string
  input: DingTalkApprovalInput
  status: 'RUNNING' | 'COMPLETED'
  result?: 'agree' | 'refuse'
  finishTime?: string
  createdAt: string
}

/**
 * 本地联调用的钉钉审批客户端。
 * 该客户端不会读取钉钉凭据，也不会发起任何网络请求；实例只存在于当前 API 进程内。
 */
export class MockDingTalkApprovalClient implements DingTalkApprovalClient {
  private readonly instances = new Map<string, MockApprovalRecord>()

  async startProcess(input: DingTalkApprovalInput): Promise<{ processInstanceId: string }> {
    const processInstanceId = `mock-dingtalk-${randomUUID()}`
    this.instances.set(processInstanceId, {
      processInstanceId,
      input: structuredClone(input),
      status: 'RUNNING',
      createdAt: new Date().toISOString(),
    })
    return { processInstanceId }
  }

  async getProcessInstance(processInstanceId: string): Promise<DingTalkProcessInstance> {
    const instance = this.instances.get(processInstanceId)
    if (!instance) throw new Error(`模拟钉钉审批实例不存在：${processInstanceId}`)
    return {
      processInstanceId,
      status: instance.status,
      ...(instance.result ? { result: instance.result } : {}),
      ...(instance.finishTime ? { finishTime: instance.finishTime } : {}),
      raw: {
        processInstanceId,
        status: instance.status,
        ...(instance.result ? { result: instance.result } : {}),
        ...(instance.finishTime ? { finishTime: instance.finishTime } : {}),
        processCode: instance.input.processCode,
        originatorUserId: instance.input.originatorUserId,
        departmentId: instance.input.departmentId,
        formValues: instance.input.formValues,
        mode: 'mock',
        createdAt: instance.createdAt,
      },
    }
  }

  decide(processInstanceId: string, decision: 'approved' | 'rejected'): DingTalkProcessInstance {
    const instance = this.instances.get(processInstanceId)
    if (!instance) throw new Error(`模拟钉钉审批实例不存在：${processInstanceId}`)
    const nextResult = decision === 'approved' ? 'agree' : 'refuse'
    if (instance.status === 'COMPLETED' && instance.result !== nextResult) {
      throw new Error('模拟审批实例已经记录了不同的最终结果')
    }
    instance.status = 'COMPLETED'
    instance.result = nextResult
    instance.finishTime ??= new Date().toISOString()
    return {
      processInstanceId,
      status: instance.status,
      result: instance.result,
      finishTime: instance.finishTime,
      raw: { mode: 'mock' },
    }
  }

  list(): Array<{ processInstanceId: string; status: string; result?: string; createdAt: string; finishTime?: string }> {
    return [...this.instances.values()].map((instance) => ({
      processInstanceId: instance.processInstanceId,
      status: instance.status,
      ...(instance.result ? { result: instance.result } : {}),
      createdAt: instance.createdAt,
      ...(instance.finishTime ? { finishTime: instance.finishTime } : {}),
    }))
  }
}

export const mockDingTalkApprovalClient = new MockDingTalkApprovalClient()
