import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  JobSpecGenerationError,
  createJobSpecGenerator,
  generateLocalJobSpec,
  loadJobSpecGeneratorConfig,
} from './job-spec-generator.js'

const validModelPayload = {
  summary: '负责核心业务系统的设计、开发与稳定性建设。',
  responsibilities: ['负责核心服务设计', '推动代码质量和性能优化', '参与技术方案评审'],
  requirements: [
    { label: '本科及以上学历', description: '计算机相关专业优先', required: true },
    { label: '三年以上开发经验', description: '具备复杂系统设计经验', required: true },
  ],
  skills: ['Java', 'Spring Boot', 'PostgreSQL', 'Redis'],
}

function responseWith(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('job spec generation', () => {
  it('generates a structured job spec from the job title', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = []
    const generator = createJobSpecGenerator(
      { baseUrl: 'https://llm.example/v1/', apiKey: 'secret', model: 'approved-model', timeoutMs: 2_000 },
      async (url, init) => {
        requests.push({ url: String(url), init })
        return responseWith(JSON.stringify(validModelPayload))
      },
    )

    const result = await generator.generate({ jobTitle: '高级后端工程师' })

    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.url, 'https://llm.example/v1/chat/completions')
    assert.equal((requests[0]?.init?.headers as Record<string, string>).Authorization, 'Bearer secret')
    assert.equal(JSON.parse(String(requests[0]?.init?.body)).messages[1].content, '{"jobTitle":"高级后端工程师"}')
    assert.deepEqual(result, { title: '高级后端工程师', ...validModelPayload, generatedBy: 'ai' })
  })

  it('loads model configuration and rejects incomplete settings', () => {
    assert.deepEqual(loadJobSpecGeneratorConfig({
      OPENAI_BASE_URL: 'https://llm.example/v1',
      OPENAI_API_KEY: 'key',
      OPENAI_MODEL: 'model-a',
      OPENAI_TIMEOUT_MS: '45000',
    }), { baseUrl: 'https://llm.example/v1', apiKey: 'key', model: 'model-a', timeoutMs: 45_000 })

    assert.throws(
      () => loadJobSpecGeneratorConfig({ OPENAI_BASE_URL: 'https://llm.example/v1' }),
      (error: unknown) => error instanceof JobSpecGenerationError && error.code === 'AI_NOT_CONFIGURED',
    )
  })

  it('accepts JSON wrapped in a markdown fence', async () => {
    const generator = createJobSpecGenerator(
      { baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'model', timeoutMs: 2_000 },
      async () => responseWith(`\`\`\`json\n${JSON.stringify(validModelPayload)}\n\`\`\``),
    )

    const result = await generator.generate({ jobTitle: '测试工程师' })
    assert.equal(result.title, '测试工程师')
    assert.equal(result.summary, validModelPayload.summary)
  })

  it('fails closed for invalid model output', async () => {
    const generator = createJobSpecGenerator(
      { baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'model', timeoutMs: 2_000 },
      async () => responseWith(JSON.stringify({ ...validModelPayload, requirements: [] })),
    )

    await assert.rejects(
      generator.generate({ jobTitle: '后端工程师' }),
      (error: unknown) => error instanceof JobSpecGenerationError && error.code === 'MODEL_RESPONSE_INVALID',
    )
  })

  it('generates a useful local fallback when the model is not configured', () => {
    const backend = generateLocalJobSpec({ jobTitle: '高级后端工程师' })
    assert.equal(backend.generatedBy, 'local_fallback')
    assert.equal(backend.title, '高级后端工程师')
    assert.ok(backend.responsibilities.some((item) => item.includes('核心服务')))
    assert.ok(backend.skills.includes('PostgreSQL/MySQL'))
    assert.ok(backend.requirements.some((item) => item.label === '5 年以上相关工作经验'))

    const generic = generateLocalJobSpec({ jobTitle: '综合管理岗' })
    assert.match(generic.summary, /综合管理岗/)
    assert.ok(generic.skills.includes('综合管理岗'))
  })
})
