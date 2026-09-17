export interface DingTalkApprovalInput {
  processCode: string
  originatorUserId: string
  departmentId: number
  formValues: Array<{ name: string; value: string }>
}

export interface DingTalkApprovalClient {
  startProcess(input: DingTalkApprovalInput): Promise<{ processInstanceId: string }>
}

export interface DingTalkApprovalClientConfig {
  appKey: string
  appSecret: string
  apiBaseUrl?: string
  fetcher?: typeof fetch
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
    if (!response.ok) throw new Error(`DingTalk access token request failed: HTTP ${response.status}`)
    const body = await response.json() as { accessToken?: unknown; expireIn?: unknown }
    if (typeof body.accessToken !== 'string' || !body.accessToken) throw new Error('DingTalk access token response is invalid')
    const expiresIn = typeof body.expireIn === 'number' ? body.expireIn : 7200
    cached = { token: body.accessToken, expiresAt: Date.now() + expiresIn * 1000 }
    return cached.token
  }

  return {
    async startProcess(input) {
      const token = await accessToken()
      const response = await fetcher(`${baseUrl}/v1.0/workflow/processInstances`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify({
          processCode: input.processCode,
          originatorUserId: input.originatorUserId,
          deptId: input.departmentId,
          formComponentValues: input.formValues,
        }),
      })
      if (!response.ok) throw new Error(`DingTalk approval start failed: HTTP ${response.status}`)
      const body = await response.json() as { instanceId?: unknown; processInstanceId?: unknown }
      const id = typeof body.instanceId === 'string' ? body.instanceId : body.processInstanceId
      if (typeof id !== 'string' || !id) throw new Error('DingTalk approval response has no process instance id')
      return { processInstanceId: id }
    },
  }
}

export function createConfiguredDingTalkApprovalClient(): DingTalkApprovalClient | undefined {
  const appKey = process.env.DINGTALK_APP_KEY?.trim()
  const appSecret = process.env.DINGTALK_APP_SECRET?.trim()
  if (!appKey || !appSecret) return undefined
  return createDingTalkApprovalClient({ appKey, appSecret })
}
