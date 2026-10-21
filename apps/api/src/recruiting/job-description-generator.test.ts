import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  JobDescriptionGenerationError,
  createJobDescriptionGenerator,
  generateLocalJobDescription,
  loadJobDescriptionGeneratorConfig,
} from './job-description-generator.js'

const validContent = '岗位名称：高级后端工程师\n\n岗位概述\n负责核心服务研发。\n\n主要职责\n1. 设计核心服务\n\n任职要求\n- 三年以上经验\n\n技能要求\nJava、PostgreSQL'

function responseWith(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('job description generation', () => {
  it('generates a JD through the configured model', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = []
    const generator = createJobDescriptionGenerator(
      { baseUrl: 'https://llm.example/v1/', apiKey: 'secret', model: 'approved-model', timeoutMs: 2_000 },
      async (url, init) => {
        requests.push({ url: String(url), init })
        return responseWith(JSON.stringify({ content: validContent }))
      },
    )

    const result = await generator.generate({ jobTitle: '高级后端工程师', spec: { summary: '负责核心服务', skills: ['Java'] } })

    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.url, 'https://llm.example/v1/chat/completions')
    assert.equal((requests[0]?.init?.headers as Record<string, string>).Authorization, 'Bearer secret')
    assert.equal(result.generatedBy, 'ai_assisted')
    assert.equal(result.content, validContent)
  })

  it('loads model configuration and rejects incomplete settings', () => {
    assert.deepEqual(loadJobDescriptionGeneratorConfig({
      OPENAI_BASE_URL: 'https://llm.example/v1',
      OPENAI_API_KEY: 'key',
      OPENAI_MODEL: 'model-a',
      OPENAI_TIMEOUT_MS: '45000',
    }), { baseUrl: 'https://llm.example/v1', apiKey: 'key', model: 'model-a', timeoutMs: 45_000 })

    assert.throws(
      () => loadJobDescriptionGeneratorConfig({ OPENAI_BASE_URL: 'https://llm.example/v1' }),
      (error: unknown) => error instanceof JobDescriptionGenerationError && error.code === 'AI_NOT_CONFIGURED',
    )
  })

  it('generates a complete local fallback from the job spec', () => {
    const result = generateLocalJobDescription({
      jobTitle: '高级后端工程师',
      spec: {
        summary: '负责核心服务设计。',
        responsibilities: ['负责服务设计', '推动性能优化'],
        requirements: [{ label: '三年以上经验', description: '具备复杂系统经验', required: true }],
        skills: ['Java', 'PostgreSQL'],
      },
    })

    assert.equal(result.generatedBy, 'local_fallback')
    assert.match(result.content, /岗位名称：高级后端工程师/)
    assert.match(result.content, /负责服务设计/)
    assert.match(result.content, /Java、PostgreSQL/)
  })

  it('fails closed for invalid model output', async () => {
    const generator = createJobDescriptionGenerator(
      { baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'model', timeoutMs: 2_000 },
      async () => responseWith(JSON.stringify({ content: '' })),
    )

    await assert.rejects(
      generator.generate({ jobTitle: '后端工程师' }),
      (error: unknown) => error instanceof JobDescriptionGenerationError && error.code === 'MODEL_RESPONSE_INVALID',
    )
  })
})


describe('model endpoint and response regression', () => {
  it('uses /v1 for a bare origin and preserves an explicit custom API path', async () => {
    for (const [baseUrl, expected] of [
      ['https://llm.example/', 'https://llm.example/v1/chat/completions'],
      ['https://llm.example/custom/api/', 'https://llm.example/custom/api/chat/completions'],
    ]) {
      let requested = ''
      const generator = createJobDescriptionGenerator(
        {baseUrl:baseUrl!,apiKey:'secret',model:'model',timeoutMs:2000},
        async (url) => {requested=String(url);return responseWith(JSON.stringify({ content: validContent }))},
      )
      await generator.generate({jobTitle:'测试岗位'})
      assert.equal(requested, expected)
    }
  })
  it('reports HTTP 200 HTML as an address problem without leaking the response or retrying', async () => {
    let requests = 0
    const generator = createJobDescriptionGenerator(
      {baseUrl:'https://llm.example/v1',apiKey:'private-secret',model:'model',timeoutMs:2000},
      async () => {requests++; return new Response('<!doctype html><html>private-secret</html>', {headers:{'content-type':'text/html'}})},
    )
    await assert.rejects(generator.generate({jobTitle:'测试岗位'}), (error: unknown) => {
      assert.ok(error instanceof JobDescriptionGenerationError)
      assert.equal(error.code,'MODEL_RESPONSE_INVALID')
      assert.match(error.message,/HTML.*接口地址/u)
      assert.equal(error.message.includes('private-secret'),false)
      return true
    })
    assert.equal(requests,1)
  })
  it('rejects malformed non-HTML JSON without returning upstream response text', async () => {
    const generator = createJobDescriptionGenerator(
      {baseUrl:'https://llm.example/v1',apiKey:'private-secret',model:'model',timeoutMs:2000},
      async () => new Response('private-secret invalid JSON'),
    )
    await assert.rejects(generator.generate({jobTitle:'测试岗位'}), (error: unknown) => {
      assert.ok(error instanceof JobDescriptionGenerationError)
      assert.match(error.message,/有效 JSON/u)
      assert.equal(error.message.includes('private-secret'),false)
      return true
    })
  })
})
