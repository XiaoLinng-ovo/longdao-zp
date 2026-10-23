import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, mock, test } from 'node:test'
import { EnterpriseAiStore } from '@smartrecruit-pro/enterprise-ai'
import { loadConfig } from '../src/config.js'
import { RecruitingService } from '../src/recruiting/service.js'
import { LiveInterviewSessionRepository } from '../src/interviews/live-session-repository.js'
import { MemoryInterviewQuestionSetRepository, type InterviewQuestionSetRecord } from '../src/interviews/interview-question-set-repository.js'
import { generateLocalInterviewQuestions } from '../src/interviews/question-generator.js'

const envKeys = ['NODE_ENV', 'AUTH_STORE_PATH', 'REQUIRE_CSRF', 'ALLOWED_ORIGINS', 'ALLOW_DEV_BOOTSTRAP_AUTH'] as const
const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]))
const origin = 'https://questions.example.test'
const input = { jobTitle: 'Test engineer', jobRequirements: ['Testing'], anonymizedResume: '[NAME] built a test platform', analysisSummary: [], questionCount: 10, stage: 'final' as const, includeCommonQuestions: true }
const bank = () => generateLocalInterviewQuestions(input).questions
let directory: string, baseUrl: string, modelUrl: string, server: Server, upstream: Server
let credentials: { session: string; csrf: string }
let record: InterviewQuestionSetRecord | null = null
let writes = 0, modelStatus = 200
const requests: Array<{ requestedGroup: string; questionCount: number; batchOffset?: number }> = []
async function listen(instance: Server) {
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  const address = instance.address()
  assert.ok(address && typeof address !== 'string')
  return 'http://127.0.0.1:' + address.port
}
async function send(body: unknown) {
  const response = await fetch(baseUrl + '/api/v1/interviews/question-test/questions', { method: 'POST',
    headers: { 'content-type': 'application/json', origin, authorization: 'Bearer ' + credentials.session,
      cookie: 'smartrecruit_csrf=' + credentials.csrf, 'x-csrf-token': credentials.csrf }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as any }
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'question-http-test-'))
  Object.assign(process.env, { NODE_ENV: 'test', AUTH_STORE_PATH: join(directory, 'auth.json'), REQUIRE_CSRF: 'true', ALLOWED_ORIGINS: origin, ALLOW_DEV_BOOTSTRAP_AUTH: 'false' })
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const request = JSON.parse(Buffer.concat(chunks).toString())
    const payload = JSON.parse(request.messages[1].content)
    requests.push(payload)
    res.writeHead(modelStatus, { 'content-type': 'application/json' })
    const questions = bank().filter(question => question.group === payload.requestedGroup)
      .slice(payload.batchOffset ?? 0, (payload.batchOffset ?? 0) + payload.questionCount)
      .map(question => ({ ...question, question: 'AI generated: ' + question.question }))
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions }) } }] }))
  })
  modelUrl = await listen(upstream)
  mock.method(EnterpriseAiStore.prototype, 'runtimeEnv', async () => ({ OPENAI_BASE_URL: modelUrl, OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'mock', OPENAI_TIMEOUT_MS: '2000' }))
  mock.method(RecruitingService.prototype, 'assertInterviewInScope', async () => {})
  mock.method(RecruitingService.prototype, 'getInterviewQuestionContext', async () => input)
  mock.method(RecruitingService.prototype, 'getInterview', async () => ({ status: 'scheduled' }))
  mock.method(LiveInterviewSessionRepository.prototype, 'findLatest', async () => null)
  mock.method(MemoryInterviewQuestionSetRepository.prototype, 'get', async () => record)
  mock.method(MemoryInterviewQuestionSetRepository.prototype, 'save', async (value: Omit<InterviewQuestionSetRecord, 'updatedAt'>) => {
    writes++
    record = { ...value, updatedAt: new Date().toISOString() }
    return record
  })
  const { createHttpServer } = await import('../src/server.js')
  server = createHttpServer(loadConfig({ NODE_ENV: 'test', PORT: '0' }))
  baseUrl = await listen(server)
  const login = await fetch(baseUrl + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'recruiter@smartrecruit.local', password: 'recruiter123' }) })
  assert.equal(login.status, 200)
  await login.json()
  const cookie = (name: string) => decodeURIComponent(login.headers.getSetCookie().find(value => value.startsWith(name + '='))!.split(';')[0]!.slice(name.length + 1))
  credentials = { session: cookie('smartrecruit_session'), csrf: cookie('smartrecruit_csrf') }
})
beforeEach(() => {
  record = { interviewId: 'question-test', generatedBy: 'test-recruiter', engine: 'llm', questions: bank(), updatedAt: '2026-10-23T00:00:00Z' }
  writes = 0
  modelStatus = 200
  requests.length = 0
})
after(async () => {
  mock.restoreAll()
  await Promise.all([server, upstream].filter(Boolean).map(instance => new Promise<void>(resolve => { instance.closeAllConnections(); instance.close(() => resolve()) })))
  for (const [key, value] of previousEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('regenerating department calls only that group and preserves all other stored questions', async () => {
  const previous = structuredClone(record!)
  const response = await send({ group: 'department', questionCount: 10, includeCommonQuestions: true })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.deepEqual(requests.map(request => request.requestedGroup), ['department'])
  assert.equal(requests[0]!.questionCount, 5)
  assert.equal(writes, 1)
  assert.equal(record!.questions.length, 25)
  for (const group of ['ai', 'hr', 'boss']) {
    assert.deepEqual(record!.questions.filter(question => question.group === group), previous.questions.filter(question => question.group === group).map(question => ({ ...question, sourceEngine: 'llm' })))
  }
  assert.ok(record!.questions.filter(question => question.group === 'department').every(question => question.question.startsWith('AI generated: ') && question.sourceEngine === 'llm'))
})
test('targeted generation adds a missing group to a legacy bank without replacing its questions', async () => {
  record!.questions = record!.questions.filter(question => question.group === 'ai')
    .map(({ group, ...question }) => question)
  const previous = structuredClone(record!)
  const response = await send({ group: 'department', questionCount: 10 })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.deepEqual(requests.map(request => request.requestedGroup), ['department'])
  assert.equal(writes, 1)
  assert.equal(record!.questions.length, 15)
  assert.deepEqual(record!.questions.filter(question => question.group === undefined),
    previous.questions.map(question => ({ ...question, sourceEngine: 'llm' })))
  assert.equal(record!.questions.filter(question => question.group === 'department').length, 5)
  assert.ok(record!.questions.every(question => question.sourceEngine === 'llm'))
})
test('failed targeted generation never writes or replaces an existing bank', async () => {
  const previous = structuredClone(record!)
  modelStatus = 503
  const response = await send({ group: 'department', questionCount: 10 })
  assert.equal(response.status, 502, JSON.stringify(response.body))
  assert.match(JSON.stringify(response.body), /已保留原题库/)
  assert.equal(writes, 0)
  assert.deepEqual(record, previous)
})
test('failed full generation preserves a mixed bank with any AI-generated question', async () => {
  record!.engine = 'local_fallback'
  record!.questions = record!.questions.map(question => ({ ...question, sourceEngine: question.group === 'department' ? 'llm' : 'local_fallback' }))
  const previous = structuredClone(record!)
  modelStatus = 503
  const response = await send({ questionCount: 10, includeCommonQuestions: true })
  assert.equal(response.status, 502, JSON.stringify(response.body))
  assert.equal(writes, 0)
  assert.deepEqual(record, previous)
})
test('fresh targeted generation saves a full mixed bank and labels its sources correctly', async () => {
  record = null
  const response = await send({ group: 'department', questionCount: 10 })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(writes, 1)
  assert.equal(record!.questions.length, 25)
  assert.equal(record!.engine, 'local_fallback')
  assert.ok(record!.questions.every(question => question.sourceEngine === (question.group === 'department' ? 'llm' : 'local_fallback')))
})
test('invalid group is rejected before requesting a model or saving data', async () => {
  const response = await send({ group: 'unknown' })
  assert.equal(response.status, 400)
  assert.equal(requests.length, 0)
  assert.equal(writes, 0)
})
