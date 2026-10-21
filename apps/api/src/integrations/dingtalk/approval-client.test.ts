import assert from 'node:assert/strict'
import test from 'node:test'
import { createDingTalkApprovalClient, testDingTalkConnection } from './approval-client.js'

test('gets an enterprise token and starts a real DingTalk workflow instance', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const responses = [
    new Response(JSON.stringify({ accessToken: 'token-1', expireIn: 7200 }), { status: 200 }),
    new Response(JSON.stringify({ instanceId: 'approval-instance-1' }), { status: 200 }),
  ]
  const client = createDingTalkApprovalClient({
    appKey: 'app-key', appSecret: 'app-secret', apiBaseUrl: 'https://api.example.test',
    fetcher: (async (url, init) => { calls.push({ url: String(url), ...(init ? { init } : {}) }); return responses.shift()! }) as typeof fetch,
  })
  const result = await client.startProcess({ processCode: 'PROC-TECH', originatorUserId: 'ding-user', departmentId: 42, formValues: [{ name: '岗位名称', value: '后端工程师' }] })
  assert.equal(result.processInstanceId, 'approval-instance-1')
  assert.equal(calls[0]?.url, 'https://api.example.test/v1.0/oauth2/accessToken')
  assert.equal(calls[1]?.url, 'https://api.example.test/v1.0/workflow/processInstances')
  assert.equal(new Headers(calls[1]?.init?.headers).get('x-acs-dingtalk-access-token'), 'token-1')
  assert.match(String(calls[1]?.init?.body), /PROC-TECH/)
})


test('tests DingTalk OAuth credentials without exposing the access token', async () => {
  let requestBody = ''
  const result = await testDingTalkConnection({
    appKey: 'app-key', appSecret: 'app-secret', apiBaseUrl: 'https://api.example.test',
    fetcher: (async (_url, init) => {
      requestBody = String(init?.body ?? '')
      return new Response(JSON.stringify({ accessToken: 'do-not-return-this-token', expireIn: 7200 }), { status: 200 })
    }) as typeof fetch,
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 200)
  assert.match(result.message, /连接成功/)
  assert.doesNotMatch(JSON.stringify(result), /do-not-return-this-token/)
  assert.match(requestBody, /app-key/)
})

test('returns actionable results for missing or rejected DingTalk credentials', async () => {
  const missing = await testDingTalkConnection()
  assert.equal(missing.ok, false)
  assert.match(missing.message, /AppKey.*AppSecret/)
  const rejected = await testDingTalkConnection({
    appKey: 'app-key', appSecret: 'wrong-secret', apiBaseUrl: 'https://api.example.test',
    fetcher: (async () => new Response('{}', { status: 401 })) as typeof fetch,
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.status, 401)
  assert.match(rejected.message, /鉴权失败/)
})
