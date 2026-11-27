import assert from 'node:assert/strict'

import { describe, it } from 'node:test'
import { describeBaseUrlHost, describeFetchFailure, readAiSettings, testAiConnection, testAiGeneration } from './ai-settings.js'

import { loadInterviewAnswerAnalyzerConfig } from '../interviews/answer-analyzer.js'
import { loadInterviewQuestionGeneratorConfig } from '../interviews/question-generator.js'
import { loadQuestionSheetGeneratorConfig } from '../interviews/question-sheet-generator.js'
import { loadJobDescriptionGeneratorConfig } from '../recruiting/job-description-generator.js'
import { loadJobSpecGeneratorConfig } from '../recruiting/job-spec-generator.js'

describe('persisted AI generation probe',()=>{
  const env={OPENAI_BASE_URL:'https://provider.example/v1',OPENAI_API_KEY:'synthetic-private-secret',OPENAI_MODEL:'model-a',OPENAI_TIMEOUT_MS:'5000'}
  it('requires real generated content and never returns provider text or credentials',async()=>{
    const result=await testAiGeneration(env,async(url,init)=>{
      assert.equal(String(url),'https://provider.example/v1/chat/completions');assert.equal(init?.redirect,'error')
      assert.equal(JSON.parse(String(init?.body)).model,'model-a')
      return new Response(JSON.stringify({choices:[{message:{content:'synthetic-private-secret'}}]}))
    })
    assert.equal(result.ok,true);assert.equal(JSON.stringify(result).includes('synthetic-private-secret'),false)
    for(const payload of [{data:[{id:'model-a'}]},{choices:[]},{choices:[{message:{content:''}}]}]){
      assert.equal((await testAiGeneration(env,async()=>new Response(JSON.stringify(payload)))).code,'AI_PROVIDER_INVALID_RESPONSE')
    }
  })
  it('does not leak error bodies or exception messages',async()=>{
    assert.equal((await testAiGeneration(env,async()=>new Response('synthetic-private-secret',{status:401}))).code,'AI_PROVIDER_HTTP_ERROR')
    const result=await testAiGeneration(env,async()=>{throw new Error('synthetic-private-secret')})
    assert.equal(result.code,'AI_PROVIDER_UNAVAILABLE');assert.equal(JSON.stringify(result).includes('synthetic-private-secret'),false)
    let called=false
    assert.equal((await testAiGeneration({},async()=>{called=true;return new Response('{}')})).code,'PLATFORM_AI_NOT_CONFIGURED')
    assert.equal(called,false)
  })
})

describe('database-only AI configuration', () => {
  it('never borrows legacy process model settings when a database configuration is omitted', async () => {
    const legacy = { OPENAI_BASE_URL: 'https://ignored.invalid/v1', OPENAI_API_KEY: 'ignored-secret', OPENAI_MODEL: 'ignored-model', OPENAI_TIMEOUT_MS: '10000' }
    const previous = Object.fromEntries(Object.keys(legacy).map(key => [key, process.env[key]]))
    Object.assign(process.env, legacy)
    try {
      assert.equal(readAiSettings().configured, false)
      assert.equal((await testAiConnection()).ok, false)
      for (const load of [loadInterviewAnswerAnalyzerConfig, loadInterviewQuestionGeneratorConfig, loadQuestionSheetGeneratorConfig, loadJobDescriptionGeneratorConfig, loadJobSpecGeneratorConfig]) {
        assert.throws(() => load(), error => error instanceof Error && !error.message.includes('ignored-secret'))
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

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

  it('未传地址与密钥时使用显式传入的数据库配置', async () => {
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

describe('AI connection response regression', () => {
  it('normalizes bare origins to /v1/models without retries', async () => {
    let calls = 0
    const result = await testAiConnection({baseUrl:'https://provider.example/',apiKey:'secret'}, {}, async (url, init) => {
      calls++
      assert.equal(String(url),'https://provider.example/v1/models')
      assert.equal(init?.redirect,'error')
      return new Response('{"data":[{"id":"model-a"}]}')
    })
    assert.equal(result.ok,true)
    assert.deepEqual(result.models,['model-a'])
    assert.equal(calls,1)
  })
  it('never treats HTML or an invalid JSON envelope as a successful connection', async () => {
    for (const body of ['<!doctype html><html>private-secret</html>', 'not-json', '{}', '{"error":{"message":"private-secret"}}']) {
      const result = await testAiConnection({baseUrl:'https://provider.example/v1',apiKey:'private-secret'}, {}, async () => new Response(body))
      assert.equal(result.ok,false)
      assert.equal(result.message.includes('private-secret'),false)
      assert.deepEqual(result.models,[])
    }
  })
  it('rejects credential-bearing URLs before sending a request', async () => {
    let called=false
    const result=await testAiConnection({baseUrl:'https://user:password@provider.example/',apiKey:'secret'}, {}, async () => {called=true;return new Response('{"data":[]}')})
    assert.equal(result.ok,false)
    assert.equal(called,false)
  })
})
