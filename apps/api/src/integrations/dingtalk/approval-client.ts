export interface DingTalkApprovalInput {
  processCode: string
  originatorUserId: string
  departmentId: number
  formValues: Array<{ name: string; value: string }>
}

export interface DingTalkProcessInstance {
  processInstanceId: string
  status?: string
  result?: string
  finishTime?: string
  raw: unknown
}

export interface DingTalkApprovalClient {
  startProcess(input: DingTalkApprovalInput): Promise<{ processInstanceId: string }>
  /** 查询审批实例详情，用于回调丢失后的补偿同步。 */
  getProcessInstance?(processInstanceId: string): Promise<DingTalkProcessInstance>
}

export interface DingTalkApprovalClientConfig {
  appKey: string
  appSecret: string
  apiBaseUrl?: string
  fetcher?: typeof fetch
}

export interface DingTalkConnectionTestInput {
  appKey?: string
  appSecret?: string
  apiBaseUrl?: string
  fetcher?: typeof fetch
}

export interface DingTalkConnectionTestResult {
  ok: boolean
  status?: number
  message: string
  latencyMs: number
}

async function responseError(response: Response, operation: string): Promise<Error> {
  let detail = ''
  try {
    const body = await response.text()
    if (body) detail = `: ${body.slice(0, 1000)}`
  } catch { /* ignore a failed error-body read */ }
  return new Error(`DingTalk ${operation} failed: HTTP ${response.status}${detail}`)
}

function describeHttpFailure(status: number): string {
  if (status === 400) return '钉钉拒绝了鉴权请求，请检查 AppKey、AppSecret 和应用状态'
  if (status === 401 || status === 403) return '钉钉鉴权失败或应用没有访问权限'
  if (status === 429) return '钉钉接口请求频率受限，请稍后重试'
  if (status >= 500) return `钉钉服务暂时不可用（HTTP ${status}）`
  return `钉钉鉴权失败（HTTP ${status}）`
}

/**
 * 只验证企业内部应用的 OAuth2 凭据，不返回 accessToken，也不调用会产生业务数据的接口。
 * 该方法供管理后台的「测试连接」使用，允许用页面中尚未保存的新凭据进行测试。
 */
export async function testDingTalkConnection(input: DingTalkConnectionTestInput = {}): Promise<DingTalkConnectionTestResult> {
  const appKey = input.appKey?.trim()
  const appSecret = input.appSecret?.trim()
  const baseUrl = (input.apiBaseUrl ?? 'https://api.dingtalk.com').replace(/\/$/u, '')
  const startedAt = Date.now()
  if (!appKey || !appSecret) {
    return { ok: false, message: '请先配置 AppKey 和 AppSecret', latencyMs: Date.now() - startedAt }
  }
  try {
    const response = await (input.fetcher ?? fetch)(`${baseUrl}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey, appSecret }),
    })
    if (!response.ok) {
      return { ok: false, status: response.status, message: describeHttpFailure(response.status), latencyMs: Date.now() - startedAt }
    }
    const body = await response.json() as { accessToken?: unknown; expireIn?: unknown }
    if (typeof body.accessToken !== 'string' || !body.accessToken) {
      return { ok: false, status: response.status, message: '钉钉返回的鉴权结果缺少 accessToken', latencyMs: Date.now() - startedAt }
    }
    const expireIn = typeof body.expireIn === 'number' ? body.expireIn : undefined
    return {
      ok: true,
      status: response.status,
      message: expireIn ? `连接成功，凭据有效期约 ${Math.round(expireIn / 60)} 分钟` : '连接成功，已获取钉钉访问凭据',
      latencyMs: Date.now() - startedAt,
    }
  } catch (error) {
    const message = error instanceof Error && /fetch|network|connect|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(error.message)
      ? '无法连接钉钉 API，请检查网络或代理配置'
      : '钉钉连接测试失败，请检查 API 地址和应用配置'
    return { ok: false, message, latencyMs: Date.now() - startedAt }
  }
}

export function createDingTalkApprovalClient(config: DingTalkApprovalClientConfig): DingTalkApprovalClient {
  const fetcher = config.fetcher ?? fetch
  const baseUrl = (config.apiBaseUrl ?? 'https://api.dingtalk.com').replace(/\/$/u, '')
  let cached: { token: string; expiresAt: number } | undefined

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
    const response = await fetcher(`${baseUrl}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: config.appKey, appSecret: config.appSecret }),
    })
    if (!response.ok) throw await responseError(response, 'access token request')
    const body = await response.json() as { accessToken?: unknown; expireIn?: unknown }
    if (typeof body.accessToken !== 'string' || !body.accessToken) throw new Error('DingTalk access token response is invalid')
    const expiresIn = typeof body.expireIn === 'number' ? body.expireIn : 7200
    cached = { token: body.accessToken, expiresAt: Date.now() + expiresIn * 1000 }
    return cached.token
  }

  async function authenticatedRequest(path: string, init: RequestInit): Promise<Response> {
    const token = await accessToken()
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json')
    headers.set('x-acs-dingtalk-access-token', token)
    const response = await fetcher(`${baseUrl}${path}`, { ...init, headers })
    if (response.status === 401 || response.status === 403) cached = undefined
    return response
  }

  return {
    async startProcess(input) {
      const response = await authenticatedRequest('/v1.0/workflow/processInstances', {
        method: 'POST',
        body: JSON.stringify({
          processCode: input.processCode,
          originatorUserId: input.originatorUserId,
          deptId: input.departmentId,
          formComponentValues: input.formValues,
        }),
      })
      if (!response.ok) throw await responseError(response, 'approval start')
      const body = await response.json() as { instanceId?: unknown; processInstanceId?: unknown }
      const id = typeof body.instanceId === 'string' ? body.instanceId : body.processInstanceId
      if (typeof id !== 'string' || !id) throw new Error('DingTalk approval response has no process instance id')
      return { processInstanceId: id }
    },

    async getProcessInstance(processInstanceId) {
      const id = encodeURIComponent(processInstanceId)
      const response = await authenticatedRequest(`/v1.0/workflow/processInstances/${id}`, { method: 'GET' })
      if (!response.ok) throw await responseError(response, 'approval detail query')
      const body = await response.json() as Record<string, unknown>
      const returnedId = [body.processInstanceId, body.instanceId, body.processInstanceIdList]
        .flatMap((value) => Array.isArray(value) ? value : [value])
        .find((value): value is string => typeof value === 'string' && value.length > 0)
      const result: DingTalkProcessInstance = { processInstanceId: returnedId ?? processInstanceId, raw: body }
      const status = [body.status, body.instanceStatus, body.processInstanceStatus, body.process_status]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      const decision = [body.result, body.approvalResult, body.approveResult]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      const finishTime = [body.finishTime, body.finishedTime, body.completeTime, body.completedAt]
        .find((value): value is string | number => typeof value === 'string' || typeof value === 'number')
      if (status) result.status = status
      if (decision) result.result = decision
      if (finishTime !== undefined) result.finishTime = String(finishTime)
      return result
    },
  }
}

export function createConfiguredDingTalkApprovalClient(): DingTalkApprovalClient | undefined {
  const appKey = process.env.DINGTALK_APP_KEY?.trim()
  const appSecret = process.env.DINGTALK_APP_SECRET?.trim()
  if (!appKey || !appSecret) return undefined
  return createDingTalkApprovalClient({ appKey, appSecret })
}
