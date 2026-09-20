import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { describeBaseUrlHost, describeFetchFailure, readAiEnvSettings, readAiSettings, testAiConnection, updateAiEnvSettings } from './ai-settings.js'

describe('AI 模型配置视图', () => {
  it('未配置时明确列出缺失项，且不泄露任何密钥', () => {
    const view = readAiSettings({})
    assert.equal(view.configured, false)
    assert.equal(view.baseUrlHost, '')
    assert.equal(view.apiKeyConfigured, false)
    assert.deepEqual(view.missing, ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL'])
  })

  it('只暴露脱敏主机，丢弃地址中的用户名和密码', () => {
    const view = readAiSettings({
      OPENAI_BASE_URL: 'https://user:secret@api.deepseek.com/v1/',
      OPENAI_API_KEY: 'sk-abcdefghijk',
      OPENAI_MODEL: 'deepseek-chat',
      OPENAI_TIMEOUT_MS: '20000',
    })
    assert.equal(view.configured, true)
    assert.equal(view.baseUrlHost, 'https://api.deepseek.com/v1')
    assert.equal(view.model, 'deepseek-chat')
    assert.equal(view.timeoutMs, 20000)
    assert.equal(view.apiKeyConfigured, true)
    assert.deepEqual(view.missing, [])
    assert.equal(JSON.stringify(view).includes('secret'), false)
    assert.equal(JSON.stringify(view).includes('sk-abcdefghijk'), false)
  })

  it('地址非法或超时非正整数时判定为未配置', () => {
    assert.equal(describeBaseUrlHost('not a url'), '地址格式无效')
    const view = readAiSettings({ OPENAI_BASE_URL: 'ftp:/bad', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm', OPENAI_TIMEOUT_MS: '0' })
    assert.equal(view.configured, false)
    assert.deepEqual(view.missing, ['OPENAI_BASE_URL', 'OPENAI_TIMEOUT_MS'])
  })
})

describe('AI 连接自检', () => {
  it('缺少地址或密钥时直接失败，且不会发起外部请求', async () => {
    let called = false
    const fetchStub = async () => { called = true; return new Response('{}', { status: 200 }) }

    const noUrl = await testAiConnection({}, {}, fetchStub)
    assert.equal(noUrl.ok, false)
    assert.match(noUrl.message, /接口地址/)
    assert.deepEqual(noUrl.models, [])

    const badUrl = await testAiConnection({ baseUrl: 'not-a-url', apiKey: 'k' }, {}, fetchStub)
    assert.equal(badUrl.ok, false)
    assert.match(badUrl.message, /http 或 https/)

    const noKey = await testAiConnection({ baseUrl: 'https://api.example.com/v1' }, {}, fetchStub)
    assert.equal(noKey.ok, false)
    assert.match(noKey.message, /API 密钥/)
    assert.equal(called, false)
  })

  it('用传入的地址与密钥拉取去重后的模型列表', async () => {
    let requested = ''
    let authorization = ''
    const ok = await testAiConnection({ baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-typed' }, {}, async (input, init) => {
      requested = String(input)
      authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '')
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }, { object: 'model' }] }), { status: 200 })
    })
    assert.equal(ok.ok, true)
    assert.equal(requested, 'https://api.example.com/v1/models')
    assert.equal(authorization, 'Bearer sk-typed')
    assert.deepEqual(ok.models, ['deepseek-chat', 'deepseek-reasoner'])

    const unauthorized = await testAiConnection({ baseUrl: 'https://api.example.com/v1', apiKey: 'k' }, {}, async () => new Response('{}', { status: 401 }))
    assert.equal(unauthorized.ok, false)
    assert.equal(unauthorized.status, 401)
    assert.match(unauthorized.message, /401/)
    assert.deepEqual(unauthorized.models, [])
  })

  it('未传地址与密钥时回落到当前生效的进程配置', async () => {
    let authorization = ''
    const env = { OPENAI_BASE_URL: 'https://env.example.com/v1', OPENAI_API_KEY: 'env-key' }
    const result = await testAiConnection({}, env, async (_input, init) => {
      authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '')
      return new Response('{"data":[]}', { status: 200 })
    })
    assert.equal(result.ok, true)
    assert.equal(authorization, 'Bearer env-key')
    assert.match(result.message, /未返回模型列表/)
  })

  it('把 fetch failed 还原成可诊断的原因', async () => {
    const dns = await testAiConnection({ baseUrl: 'https://api.example.com/v1', apiKey: 'k' }, {}, async () => { const error = new TypeError('fetch failed') as TypeError & { cause?: unknown }; error.cause = { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.example.com' }; throw error })
    assert.match(dns.message, /无法解析接口地址的域名/)

    const refused = await testAiConnection({ baseUrl: 'https://api.example.com/v1', apiKey: 'k' }, {}, async () => { const error = new TypeError('fetch failed') as TypeError & { cause?: unknown }; error.cause = { code: 'ECONNREFUSED' }; throw error })
    assert.match(refused.message, /拒绝连接/)

    assert.equal(describeFetchFailure(new Error('boom')), 'boom')
    assert.equal(describeFetchFailure({ cause: { code: 'ECONNRESET' } }), '连接被对端重置')
  })
})

describe('AI 模型配置写入', () => {
  it('把地址、模型与超时写入 .env，密钥只以掩码返回', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-settings-'))
    const file = join(dir, '.env')
    try {
      const saved = await updateAiEnvSettings(file, {
        OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
        OPENAI_API_KEY: 'sk-1234567890',
        OPENAI_MODEL: 'deepseek-chat',
        OPENAI_TIMEOUT_MS: '30000',
      })
      assert.equal(saved.OPENAI_BASE_URL.value, 'https://api.deepseek.com/v1')
      assert.equal(saved.OPENAI_MODEL.value, 'deepseek-chat')
      assert.equal(saved.OPENAI_API_KEY.value, 'sk••••90')
      assert.equal(saved.OPENAI_API_KEY.configured, true)

      const content = await readFile(file, 'utf8')
      assert.match(content, /OPENAI_BASE_URL=https:\/\/api\.deepseek\.com\/v1/)
      assert.match(content, /OPENAI_API_KEY=sk-1234567890/)

      const reread = await readAiEnvSettings(file)
      assert.equal(reread.OPENAI_API_KEY.value, 'sk••••90')
      assert.equal(process.env.OPENAI_MODEL, 'deepseek-chat')
    } finally {
      delete process.env.OPENAI_BASE_URL
      delete process.env.OPENAI_API_KEY
      delete process.env.OPENAI_MODEL
      delete process.env.OPENAI_TIMEOUT_MS
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('拒绝非法地址、内嵌凭据、非正整数超时与换行注入', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-settings-'))
    const file = join(dir, '.env')
    try {
      await assert.rejects(updateAiEnvSettings(file, { OPENAI_BASE_URL: 'not-a-url' }), /接口地址必须是合法地址/)
      await assert.rejects(updateAiEnvSettings(file, { OPENAI_BASE_URL: 'ftp://api.example.com' }), /只支持 http 或 https/)
      await assert.rejects(updateAiEnvSettings(file, { OPENAI_BASE_URL: 'https://user:pass@api.example.com' }), /不能包含用户名或密码/)
      await assert.rejects(updateAiEnvSettings(file, { OPENAI_TIMEOUT_MS: '0' }), /超时必须是正整数/)
      await assert.rejects(updateAiEnvSettings(file, { OPENAI_MODEL: 'a\nb' }), /不能包含换行符/)
      await assert.rejects(updateAiEnvSettings(file, { OPENAI_UNKNOWN: 'x' } as never), /不支持的模型配置项/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
