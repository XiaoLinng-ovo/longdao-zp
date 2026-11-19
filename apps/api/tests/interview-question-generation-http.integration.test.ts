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
import { generateLocalInterviewQuestions, type GeneratedInterviewQuestion } from '../src/interviews/question-generator.js'

const envKeys = ['NODE_ENV', 'AUTH_STORE_PATH', 'REQUIRE_CSRF', 'ALLOWED_ORIGINS', 'ALLOW_DEV_BOOTSTRAP_AUTH'] as const
const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]))
const origin = 'https://questions.example.test'
// Production context defaults to five; the room explicitly generates ten resume questions.
const input = { jobTitle: 'Test engineer', jobRequirements: ['Testing'], anonymizedResume: '[NAME] built a test platform', analysisSummary: [], questionCount: 5, stage: 'final' as const, includeCommonQuestions: true }
const bank = () => generateLocalInterviewQuestions({ ...input, questionCount: 10 }).questions
let directory: string, baseUrl: string, modelUrl: string, server: Server, upstream: Server
let credentials: { session: string; csrf: string }
let record: InterviewQuestionSetRecord | null = null
let writes = 0, modelStatus = 200
let modelEvidence: string[] | undefined
let discussionResult: Record<string, unknown> = {}
const requests: Array<{ requestedGroup: string; anonymizedResume: string; jobTitle: string; questionCount?: number; batchOffset?: number; scope?: string; selectedQuestion?: { question: string }; currentQuestions?: Array<{ question: string }> }> = []
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
    if (payload.scope === 'discussion') {
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(discussionResult) } }] }))
      return
    }
    const questions = (payload.currentQuestions ?? bank().filter(question => question.group === payload.requestedGroup))
      .slice(payload.batchOffset ?? 0, (payload.batchOffset ?? 0) + payload.questionCount)
      .map((question: GeneratedInterviewQuestion) => ({ ...question, ...(modelEvidence ? { groundedIn: modelEvidence } : {}), group: question.group ?? payload.requestedGroup, question: 'AI generated: ' + question.question }))
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
  modelEvidence = undefined
  discussionResult = { assistantMessage: '1. New project question?\n2. New collaboration question?\n3. New innovation question?' }
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
for (const group of ['ai', 'hr', 'department', 'boss'] as const) {
  test(group + ' regeneration uses this candidate resume and saves traceable personal questions only', async () => {
    const response = await send({ group, questionCount: 10, includeCommonQuestions: true })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.ok(requests.every(request => request.anonymizedResume === input.anonymizedResume && request.jobTitle === input.jobTitle))
    const questions = record!.questions.filter(question => question.group === group)
    assert.equal(questions.length, group === 'ai' ? 10 : 5)
    assert.ok(questions.every(question => question.groundedIn.some(quote => input.anonymizedResume.includes(quote) && question.question.includes(quote))))
    assert.equal(writes, 1)
  })
  test(group + ' rejects non-resume evidence without overwriting the saved bank', async () => {
    const previous = structuredClone(record!)
    modelEvidence = ['岗位能力要求：Testing', 'another candidate led a sales team']
    const response = await send({ group, questionCount: 10, includeCommonQuestions: true })
    assert.notEqual(response.status, 200)
    assert.equal(requests.length, 2)
    assert.equal(writes, 0)
    assert.deepEqual(record, previous)
  })
}
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

for (const group of ['ai', 'hr', 'department', 'boss'] as const) {
  for (const count of [1, 3, 7, 12, 23]) {
    test('discussion on ' + group + ' with ' + count + ' saved questions returns new questions in chat only', async () => {
      const current = Array.from({ length: count }, (_, index) => ({ ...bank()[0]!, group,
        question: 'Saved question ' + index, scoringRubric: [{ criterion: 'Evidence ' + index, points: index + 1 }],
      }))
      record!.questions = [...bank().filter(question => question.group !== group), ...current]
      const previous = structuredClone(record!)
      const response = await send({ refinement: { group, messages: [{ role: 'user', content: 'Give me three new questions.' }] } })
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(requests.length, 1)
      assert.equal(requests[0]!.scope, 'discussion')
      assert.equal('questionCount' in requests[0]!, false)
      assert.equal('selectedQuestion' in requests[0]!, false)
      assert.deepEqual(requests[0]!.currentQuestions, current)
      assert.equal(response.body.data.assistantMessage, discussionResult.assistantMessage)
      assert.equal(response.body.data.mode, 'discussion')
      assert.equal(response.body.data.bankUpdated, false)
      assert.deepEqual(response.body.data.questions, previous.questions)
      assert.equal(response.body.data.updatedAt, previous.updatedAt)
      assert.equal(writes, 0)
      assert.deepEqual(record, previous)
    })
  }
  test('legacy single-question edits for ' + group + ' are rejected without requesting the model or saving', async () => {
    const previous = structuredClone(record!)
    const response = await send({ refinement: { group, target: { index: 0, question: 'Saved question' }, messages: [{ role: 'user', content: 'Change this question.' }] } })
    assert.equal(response.status, 400)
    assert.match(JSON.stringify(response.body), /QUESTION_EDIT_UNSUPPORTED/)
    assert.equal(requests.length, 0)
    assert.equal(writes, 0)
    assert.deepEqual(record, previous)
  })
  test('empty ' + group + ' groups are rejected without calling a model or writing', async () => {
    record!.questions = bank().filter(question => question.group !== group)
    const response = await send({ refinement: { group, messages: [{ role: 'user', content: 'Give me new questions.' }] } })
    assert.equal(response.status, 409)
    assert.match(JSON.stringify(response.body), /QUESTION_GROUP_INCOMPLETE/)
    assert.equal(requests.length, 0)
    assert.equal(writes, 0)
  })
}

test('even a model response containing replacement questions cannot update the saved bank', async () => {
  const previous = structuredClone(record!)
  discussionResult.questions = bank().map(question => ({ ...question, question: 'Do not persist this question' }))
  const response = await send({ refinement: { group: 'ai', messages: [{ role: 'user', content: 'Replace the entire table.' }] } })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.body.data.assistantMessage, discussionResult.assistantMessage)
  assert.deepEqual(response.body.data.questions, previous.questions)
  assert.equal(writes, 0)
  assert.deepEqual(record, previous)
})

for (const result of [{}, { assistantMessage: '' }, { assistantMessage: '   ' }, { questions: [] }]) {
  test('missing chat content fails safely and preserves the saved bank: ' + JSON.stringify(result), async () => {
    const previous = structuredClone(record!)
    discussionResult = result
    const response = await send({ refinement: { group: 'hr', messages: [{ role: 'user', content: 'Give me new questions.' }] } })
    assert.equal(response.status, 502, JSON.stringify(response.body))
    assert.equal(requests.length, 2)
    assert.equal(writes, 0)
    assert.deepEqual(record, previous)
  })
}

test('upstream discussion failure preserves the entire saved bank', async () => {
  const previous = structuredClone(record!)
  modelStatus = 503
  const response = await send({ refinement: { group: 'ai', messages: [{ role: 'user', content: 'Focus on technical depth.' }] } })
  assert.equal(response.status, 502, JSON.stringify(response.body))
  assert.equal(writes, 0)
  assert.deepEqual(record, previous)
})
