import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, mock, test } from 'node:test'
import { loadConfig } from '../src/config.js'
import { LiveInterviewSessionRepository, type LiveSegment, type LiveSession } from '../src/interviews/live-session-repository.js'
import { InterviewSummaryService } from '../src/interviews/interview-summary-service.js'
import { InterviewAudioRecordingRepository, type InterviewAudioRecording, type InterviewAudioManifestEntry } from '../src/interviews/audio-recording-repository.js'
import { FullInterviewAudio, FullAudioError, type FullAudioSource } from '../src/interviews/full-audio.js'
import type { InterviewAnswerAnalysis, InterviewAnswerAnalysisInput } from '../src/interviews/answer-analyzer.js'
import { EnterpriseAiStore } from '@smartrecruit-pro/enterprise-ai'

const envKeys = ['NODE_ENV', 'AUTH_STORE_PATH', 'REQUIRE_CSRF', 'ALLOWED_ORIGINS', 'ALLOW_DEV_BOOTSTRAP_AUTH',
  'FUNASR_BASE_URL', 'FUNASR_TIMEOUT_MS', 'FASTER_WHISPER_BASE_URL', 'FASTER_WHISPER_TIMEOUT_MS', 'FASTER_WHISPER_TOKEN', 'S3_ENDPOINT', 'RECRUITING_QUARANTINE_ROOT',
  'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_TIMEOUT_MS'] as const
const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]))
const origin = 'https://transcript.example.test'
const fullText = 'Please describe your project. I developed the platform and completed the testing.'
let directory: string, baseUrl: string, interviewId: string
let server: Server | undefined, asr: Server | undefined
let credentials: { session: string; csrf: string }
let upstreamStatus = 200, upstreamCalls = 0, fallbackCalls = 0
let upstreamRows: unknown[] = []
const modelInputs: InterviewAnswerAnalysisInput[] = []
const analyses: Array<{ question: string; analysis: InterviewAnswerAnalysis }> = []
const saved: LiveSegment[] = []
const recordings = new Map<string, InterviewAudioRecording & { objectKey: string }>()
const summaryRequests: Array<{ interviewId: string; actorId: string }> = []
let rejectSummary = false
const session: LiveSession = { id: 'checkpoint-session', interviewId: '', status: 'active', externalStatus: 'ready',
  startedAt: '2026-10-16T00:00:00Z', createdBy: 'test-recruiter', currentQuestion: 'Describe your project' }

async function listen(instance: Server): Promise<string> {
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  const address = instance.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}
async function send(method: string, path: string, payload: unknown = {}, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/api/v1${path}`, { method,
    headers: { 'content-type': 'application/json', origin, authorization: `Bearer ${credentials.session}`,
      cookie: `smartrecruit_csrf=${credentials.csrf}`, 'x-csrf-token': credentials.csrf, ...headers },
    ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }) })
  return { status: response.status, body: await response.json() as any }
}
const payload = () => ({ audioBase64: Buffer.from('test audio').toString('base64'), contentType: 'audio/webm',
  chunkOffsetMs: 15000, streamingTranscript: { text: fullText, endMs: 30000, complete: true } })
const segmentPath = '/interview-live-sessions/checkpoint-session/segments'

before(async () => {
  process.env.NODE_ENV = 'test'
  process.env.FASTER_WHISPER_BASE_URL = ''
  process.env.FASTER_WHISPER_TOKEN = ''
  process.env.REQUIRE_CSRF = 'true'
  process.env.ALLOWED_ORIGINS = origin
  process.env.ALLOW_DEV_BOOTSTRAP_AUTH = 'false'
  directory = await mkdtemp(join(tmpdir(), 'live-transcript-test-'))
  process.env.AUTH_STORE_PATH = join(directory, 'auth.json')
  process.env.RECRUITING_QUARANTINE_ROOT = join(directory, 'audio')
  delete process.env.S3_ENDPOINT
  asr = createServer(async (req, res) => {
    if (req.url === '/chat/completions') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const request = JSON.parse(Buffer.concat(chunks).toString())
      const input = JSON.parse(request.messages[1].content) as InterviewAnswerAnalysisInput
      modelInputs.push(input)
      res.writeHead(200, { 'content-type': 'application/json' })
      const response = input.question ? { questionKind: 'assessment', summary: '实际项目交付',
        evidence: ['完成了测试'], scores: [{ dimension: '项目交付', score: 7, rationale: '有开发及测试经历', questionQuote: '请介绍项目', evidence: ['完成了测试'] }],
        concerns: [], confidence: .8, nextQuestion: '建议但尚未问过的题目' } : { questionKind: 'unreviewed', summary: '需进一步核实，暂不评分。', evidence: [], scores: [], concerns: [], confidence: 0, nextQuestion: '' }
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...response,
        ...(input.refineTranscript ? { transcriptRefinement: { text: input.candidateAnswer, corrections: [], uncertainties: [] } } : {}),
      }) } }] }))
      return
    }
    for await (const _ of req) { /* Consume the uploaded audio. */ }
    if (req.url === '/fallback') {
      fallbackCalls++
      assert.equal(req.headers.authorization, 'Bearer fallback-test-token')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ segments: [{ speakerId: 'speaker_0', text: fullText, startMs: 0, endMs: 301000, speakerVerified: false, speakerMixed: true }] }))
      return
    }
    upstreamCalls++
    res.writeHead(upstreamStatus, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ segments: upstreamRows }))
  })
  process.env.FUNASR_BASE_URL = await listen(asr)
  process.env.OPENAI_BASE_URL = process.env.FUNASR_BASE_URL
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.OPENAI_MODEL = 'test-model'
  process.env.OPENAI_TIMEOUT_MS = '2000'
  mock.method(EnterpriseAiStore.prototype, 'runtimeEnv', async () => ({ ...process.env }))
  mock.method(InterviewAudioRecordingRepository.prototype, 'save', async (input: { sessionId: string; objectKey: string; contentType: string; offsetMs: number; endMs: number | null; byteLength: number }) => {
    const previous = recordings.get(input.objectKey)
    recordings.set(input.objectKey, { ...input, id: previous?.id ?? randomUUID(), sessionStartedAt: session.startedAt,
      createdAt: new Date().toISOString(), endMs: input.endMs ?? previous?.endMs ?? null })
  })
  mock.method(InterviewAudioRecordingRepository.prototype, 'list', async (id: string) => id === interviewId ? [...recordings.values()].sort((a, b) => a.offsetMs - b.offsetMs).map(({ objectKey: _, ...row }) => row) : [])
  mock.method(InterviewAudioRecordingRepository.prototype, 'find', async (id: string, recordingId: string) => id === interviewId ? [...recordings.values()].find(row => row.id === recordingId) : undefined)
  mock.method(InterviewAudioRecordingRepository.prototype, 'manifest', async (id: string, sessionId: string) => id === interviewId ? [...recordings.values()].filter(row => row.sessionId === sessionId) : [])
  process.env.FUNASR_TIMEOUT_MS = '2000'
  mock.method(LiveInterviewSessionRepository.prototype, 'get', async () => ({ session, segments: [...saved] }))
  mock.method(LiveInterviewSessionRepository.prototype, 'getAnalysisContext', async (id: string) => ({
    segment: saved.find(row => row.id === id)!, interviewId, jobTitle: '工程师', jobRequirements: ['开发与测试'],
  }))
  mock.method(LiveInterviewSessionRepository.prototype, 'getUtteranceText', async (_id: string, ids: string[]) => saved.filter(row => ids.includes(row.id)).map(row => row.text).join(''))
  mock.method(LiveInterviewSessionRepository.prototype, 'saveAnalysis', async (id: string, question: string, analysis: InterviewAnswerAnalysis) => {
    analyses.push({ question, analysis })
    return saved.find(row => row.id === id)!
  })
  mock.method(LiveInterviewSessionRepository.prototype, 'end', async () => ({ ...session, status: 'completed' }))
  mock.method(InterviewSummaryService.prototype, 'latest', async () => ({ sessionId: session.id, status: 'pending', report: null, error: null, revision: 1 }))
  mock.method(InterviewSummaryService.prototype, 'request', async (id: string, actorId: string) => {
    if (rejectSummary) throw new Error('queue unavailable')
    summaryRequests.push({ interviewId: id, actorId })
    return { sessionId: session.id, status: 'pending', report: null, error: null, revision: 1 }
  })
  mock.method(LiveInterviewSessionRepository.prototype, 'addSegment', async (sessionId: string, input: Omit<LiveSegment, 'id' | 'sessionId' | 'status'>) => {
    const row = { ...input, id: `saved-${saved.length}`, sessionId, status: 'transcribed' }
    saved.push(row)
    return row
  })
  const { createHttpServer } = await import('../src/server.js')
  server = createHttpServer(loadConfig({ NODE_ENV: 'test', PORT: '0' }))
  baseUrl = await listen(server)
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'recruiter@smartrecruit.local', password: 'recruiter123' }) })
  assert.equal(login.status, 200)
  await login.json()
  const cookies = login.headers.getSetCookie()
  const cookie = (name: string) => decodeURIComponent(cookies.find(value => value.startsWith(`${name}=`))!.split(';')[0]!.slice(name.length + 1))
  credentials = { session: cookie('smartrecruit_session'), csrf: cookie('smartrecruit_csrf') }
  const created = await send('POST', '/interviews', { applicationId: 'application-8821', title: 'Transcript test',
    scheduledStartAt: '2026-10-20T02:00:00.000Z', location: 'Test room', participants: [{ userId: 'user-interviewer', role: 'interviewer' }] })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  interviewId = created.body.data.id
  session.interviewId = interviewId
})

after(async () => {
  for (const instance of [server, asr]) if (instance?.listening) await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()))
  mock.restoreAll()
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('persists the full stream with original audio when offline ASR loses clauses; replay does not duplicate it', async () => {
  upstreamRows = [{ text: 'Ah.', speakerId: 'speaker_0', startMs: 0, endMs: 500 }]
  const response = await send('POST', segmentPath, payload(), { 'Idempotency-Key': 'checkpoint-full' })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  const row = response.body.data[0]
  assert.equal(row.text, fullText)
  assert.equal(row.role, 'unknown')
  assert.ok(row.confidence < .6)
  assert.equal(row.speakerId, 'chunk_15000:stream_15000')
  assert.deepEqual([row.startMs, row.endMs], [15000, 30000])
  assert.match((saved[0] as LiveSegment & { audioObjectKey: string }).audioObjectKey, /interviews\/checkpoint-session\/audio\/15000-/)
  assert.equal((await readdir(join(directory, 'audio', 'interviews', 'checkpoint-session', 'audio'))).length, 1)
  const replay = await send('POST', segmentPath, payload(), { 'Idempotency-Key': 'checkpoint-full' })
  assert.deepEqual(replay.body.data, response.body.data)
  assert.equal(saved.length, 1)
  assert.equal(upstreamCalls, 1)
  const restored = await send('GET', '/interview-live-sessions/checkpoint-session')
  assert.equal(restored.body.data.segments[0].text, fullText)
})

test('persists the stream even when offline ASR fails, but does not fabricate text without a checkpoint', async () => {
  upstreamStatus = 503
  const fallback = await send('POST', segmentPath, payload())
  assert.equal(fallback.status, 201, JSON.stringify(fallback.body))
  assert.equal(fallback.body.data[0].text, fullText)
  assert.equal(fallback.body.data[0].role, 'unknown')
  const { streamingTranscript: _, ...audioOnly } = payload()
  const failed = await send('POST', segmentPath, audioOnly)
  assert.equal(failed.status, 502)
  assert.equal(failed.body.error.code, 'FUNASR_UPSTREAM')
  upstreamStatus = 200
})

test('original audio survives ASR failure, retries deduplicate, playback is scoped and preserves bytes and ranges', async () => {
  const count = recordings.size, savedCount = saved.length
  upstreamStatus = 503
  const input = { audioBase64: Buffer.from('original recording without transcript').toString('base64'), contentType: 'audio/webm;codecs=opus', chunkOffsetMs: 40000 }
  try {
    assert.equal((await send('POST', segmentPath, input)).status, 502)
    assert.equal((await send('POST', segmentPath, input)).status, 502)
    assert.equal(recordings.size, count + 1)
    assert.equal(saved.length, savedCount)
  } finally { upstreamStatus = 200 }
  const list = await send('GET', '/interviews/' + interviewId + '/recordings')
  assert.equal(list.status, 200)
  const rows = list.body.data as InterviewAudioRecording[]
  const row = rows.find(item => item.offsetMs === 40000)!
  assert.ok(row); assert.equal(row.byteLength, 37)
  assert.equal('objectKey' in row, false)
  assert.deepEqual(rows.map(item => item.offsetMs), [...rows.map(item => item.offsetMs)].sort((a, b) => a - b))
  const path = baseUrl + '/api/v1/interviews/' + interviewId + '/recordings/' + row.id
  const calls = upstreamCalls
  const auth = { authorization: 'Bearer ' + credentials.session }
  const full = await fetch(path, { headers: auth })
  assert.equal(full.status, 200); assert.match(full.headers.get('content-type')!, /audio\/webm/)
  assert.equal(full.headers.get('cache-control'), 'private, no-store')
  assert.equal(await full.text(), 'original recording without transcript')
  for (const [range, expected] of [['bytes=0-7', 'original'], ['bytes=-10', 'transcript'], ['bytes=27-', 'transcript']]) {
    const part = await fetch(path, { headers: { ...auth, range: range! } })
    assert.equal(part.status, 206); assert.equal(await part.text(), expected)
    assert.match(part.headers.get('content-range')!, /^bytes /)
  }
  const invalid = await fetch(path, { headers: { ...auth, range: 'bytes=10000-' } })
  assert.equal(invalid.status, 416)
  assert.equal((await fetch(path)).status, 401)
  assert.equal((await send('GET', '/interviews/' + interviewId + '/recordings/' + randomUUID())).status, 404)
  const other = await send('POST', '/interviews', { applicationId: 'application-8821', title: 'Other interview', scheduledStartAt: '2026-10-21T02:00:00.000Z', location: 'Test room', participants: [{ userId: 'user-interviewer', role: 'interviewer' }] })
  assert.equal(other.status, 201)
  assert.equal((await send('GET', '/interviews/' + other.body.data.id + '/recordings/' + row.id)).status, 404)
  assert.equal(upstreamCalls, calls)
})

test('full audio endpoint scopes manifests, validates sources, requires login and supports seek ranges', async () => {
  const fullSessionId = randomUUID()
  const manifest = mock.method(InterviewAudioRecordingRepository.prototype,'manifest',async (id: string,sessionId: string) => id === interviewId && sessionId === fullSessionId
    ? [{...recordings.values().next().value!,sessionId:fullSessionId}] : [])
  const loader = mock.method(FullInterviewAudio.prototype, 'load', async (sessionId: string, manifest: InterviewAudioManifestEntry[], source: FullAudioSource) => {
    if (!manifest.length) throw new FullAudioError(404,'该场次没有此音源的录音')
    assert.equal(sessionId,fullSessionId); assert.equal(source,'meeting')
    assert.ok(manifest.every(row => row.sessionId === fullSessionId))
    return Buffer.from('full interview recording')
  })
  try {
    const path = baseUrl + '/api/v1/interviews/' + interviewId + '/recordings/full?sessionId=' + fullSessionId + '&source=meeting'
    const auth = {authorization:'Bearer ' + credentials.session}
    const full = await fetch(path,{headers:auth})
    assert.equal(full.status,200); assert.equal(full.headers.get('content-type'),'audio/mp4')
    assert.equal(full.headers.get('cache-control'),'private, no-store'); assert.equal(await full.text(),'full interview recording')
    const part = await fetch(path,{headers:{...auth,range:'bytes=5-13'}})
    assert.equal(part.status,206); assert.equal(await part.text(),'interview')
    assert.equal((await fetch(path)).status,401)
    assert.equal((await fetch(path.replace('source=meeting','source=invalid'),{headers:auth})).status,400)
    assert.equal((await fetch(path.replace(fullSessionId,randomUUID()),{headers:auth})).status,404)
    assert.equal((await fetch(path.replace(interviewId,randomUUID()),{headers:auth})).status,404)
  } finally { loader.mock.restore(); manifest.mock.restore() }
})

test('keeps acoustic segmentation when it covers all streaming words', async () => {
  upstreamRows = [{ text: 'Please describe your project.', speakerId: 'speaker_1', startMs: 0, endMs: 2000 },
    { text: 'I developed the platform and completed the testing.', speakerId: 'speaker_2', startMs: 2000, endMs: 14000 }]
  const response = await send('POST', segmentPath, payload())
  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.equal(response.body.data.length, 2)
  assert.deepEqual(response.body.data.map((row: LiveSegment) => row.startMs), [15000, 17000])
  assert.ok(response.body.data.every((row: LiveSegment) => !row.speakerId.includes('stream_')))
})

test('retains two verified speakers when streaming adds a missing clause and excludes recovery from scoring', async () => {
  upstreamRows = [
    { text: '请介绍项目。', speakerId: 'speaker_0', startMs: 0, endMs: 2000, speakerVerified: true },
    { text: '我负责平台开发。', speakerId: 'speaker_1', startMs: 2200, endMs: 12000, speakerVerified: true },
  ]
  const response = await send('POST', segmentPath, { ...payload(),
    streamingTranscript: { text: '请介绍项目。我负责平台开发。也承担测试。', endMs: 30000, complete: true },
  })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  const rows = response.body.data as LiveSegment[]
  assert.deepEqual(rows.map(row => row.text), ['请介绍项目。', '我负责平台开发。', '也承担测试。'])
  assert.deepEqual(rows.map(row => row.role), ['interviewer', 'candidate', 'unknown'])
  assert.deepEqual(rows.slice(0, 2).map(row => [row.startMs, row.endMs]), [[15000, 17000], [17200, 27000]])
  assert.notEqual(rows[0]!.speakerId, rows[1]!.speakerId)
  const analysis = await send('POST', `/interview-live-segments/${rows[2]!.id}/analyze`, {})
  assert.equal(analysis.status, 409)
  assert.equal(analysis.body.error.code, 'CANDIDATE_ROLE_UNCONFIRMED')
  const restored = await send('GET', '/interview-live-sessions/checkpoint-session')
  for (const row of rows) assert.ok(restored.body.data.segments.some((saved: LiveSegment) => saved.id === row.id && saved.text === row.text))
})

test('missing prefix, middle and tail survive upload, timestamp sorting and reload in the correct order', async () => {
  upstreamRows = [
    { text: '先检索切片。', speakerId: 'speaker_0', startMs: 3000, endMs: 5000, speakerVerified: true },
    { text: '再进行重排序。', speakerId: 'speaker_1', startMs: 9000, endMs: 12000, speakerVerified: true },
  ]
  const text = '每个切片之间保留重叠，便于检索。先检索切片。比较相似程度。再进行重排序。最后生成答案。'
  const response = await send('POST', segmentPath, { ...payload(), chunkOffsetMs: 60000,
    streamingTranscript: { text, endMs: 75000, complete: true },
  })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  const rows = response.body.data as LiveSegment[]
  assert.equal(rows.map(row => row.text).join(''), text)
  assert.deepEqual(rows.map(row => [row.startMs, row.endMs]), [[60000, 63000], [63000, 65000], [65000, 69000], [69000, 72000], [72000, 75000]])
  assert.ok([rows[0], rows[2], rows[4]].every(row => row!.role === 'unknown'))
  const restored = await send('GET', '/interview-live-sessions/checkpoint-session')
  const ids = new Set(rows.map(row => row.id))
  const reloaded = (restored.body.data.segments as LiveSegment[]).filter(row => ids.has(row.id)).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  assert.equal(reloaded.map(row => row.text).join(''), text)
})

test('a longer divergent offline result cannot erase an unfinished live preview', async () => {
  upstreamRows = [{ text: '我负责开发平台，也负责数据管理和测试，并且还参与其他方面的维护工作。', speakerId: 'speaker_0', startMs: 0, endMs: 14000, speakerVerified: true }]
  const text = '检索切片后比较相关性，再进行重排序。'
  const response = await send('POST', segmentPath, { ...payload(),
    streamingTranscript: { text, endMs: 30000, complete: false },
  })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.deepEqual(response.body.data.map((row: LiveSegment) => row.text), [text])
  assert.equal(response.body.data[0].role, 'unknown')
})

test('rejects invalid checkpoints before storing audio and requires authorization and CSRF', async () => {
  const count = saved.length, calls = upstreamCalls
  for (const value of [null, {}, { text: '', endMs: 30000, complete: true },
    { text: fullText, endMs: 14000, complete: true }, { text: fullText, endMs: 30000, complete: 'true' }]) {
    const response = await send('POST', segmentPath, { ...payload(), streamingTranscript: value })
    assert.equal(response.status, 400, JSON.stringify(response.body))
  }
  assert.equal((await send('POST', segmentPath, payload(), { authorization: '' })).status, 401)
  assert.equal((await send('POST', segmentPath, payload(), { 'x-csrf-token': '' })).status, 403)
  assert.equal(saved.length, count)
  assert.equal(upstreamCalls, calls)
})

test('minor preview differences cannot discard offline sentences; alternatives survive replay and reload', async () => {
  const text = '我负责平台开发。团队一共八个人。我还承担测试和上线工作。'
  upstreamRows = [{ text, speakerId: 'speaker_0', startMs: 0, endMs: 14000 }]
  const body = { ...payload(), streamingTranscript: { text: '我负责平台的开发。', endMs: 30000, complete: false } }
  const response = await send('POST', segmentPath, body, { 'Idempotency-Key': 'minor-preview-difference' })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.equal(response.body.data.map((row: LiveSegment) => row.text).join(''), text)
  const row = response.body.data[0]
  assert.deepEqual(row.transcriptComparison, { streamingText: body.streamingTranscript.text, offlineText: text,
    streamingComplete: false, selectedSource: 'offline', startMs: 15000, endMs: 30000 })
  const count = saved.length
  const replay = await send('POST', segmentPath, body, { 'Idempotency-Key': 'minor-preview-difference' })
  assert.deepEqual(replay.body.data, response.body.data)
  assert.equal(saved.length, count)
  const restored = await send('GET', '/interview-live-sessions/checkpoint-session')
  assert.deepEqual(restored.body.data.segments.find((item: LiveSegment) => item.id === row.id).transcriptComparison, row.transcriptComparison)
})

test('ambiguous recognizer differences preserve both texts without inserting duplicate dialogue', async () => {
  const text = '我负责平台开发和测试。', stream = '我不负责平台开发。我负责需求整理。'
  upstreamRows = [{ text, speakerId: 'speaker_0', startMs: 0, endMs: 14000 }]
  const response = await send('POST', segmentPath, { ...payload(), streamingTranscript: { text: stream, endMs: 30000, complete: true } })
  assert.equal(response.status, 201)
  assert.equal(response.body.data.length, 1)
  assert.equal(response.body.data[0].text, stream)
  assert.equal(response.body.data[0].role, 'unknown')
  assert.equal(response.body.data[0].transcriptComparison.offlineText, text)
})

test('summary endpoints require authentication, CSRF and an interview within scope', async () => {
  const path = `/interviews/${interviewId}/summary`
  assert.equal((await send('GET', path, {}, { authorization: '' })).status, 401)
  assert.equal((await send('POST', path, {}, { 'x-csrf-token': '' })).status, 403)
  const missing = await send('GET', '/interviews/unknown-interview/summary')
  assert.ok([403, 404].includes(missing.status), JSON.stringify(missing.body))
  const read = await send('GET', path)
  assert.equal(read.status, 200); assert.equal(read.body.data.status, 'pending')
  const requested = await send('POST', path)
  assert.equal(requested.status, 202)
  assert.equal(summaryRequests.at(-1)!.interviewId, interviewId)
  assert.ok(summaryRequests.at(-1)!.actorId)
})

test('ending queues the actual dialogue summary and preserves successful completion if queuing fails', async () => {
  const result = await send('POST', '/interview-live-sessions/checkpoint-session/end')
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.data.status, 'completed')
  assert.deepEqual(result.body.data.summaryGeneration, { queued: true })
  rejectSummary = true
  const failedQueue = await send('POST', '/interview-live-sessions/checkpoint-session/end')
  assert.equal(failedQueue.status, 200)
  assert.equal(failedQueue.body.data.status, 'completed')
  assert.equal(failedQueue.body.data.summaryGeneration.queued, false)
  assert.match(failedQueue.body.data.summaryGeneration.reason, /已保存/)
})

test('answer analysis ignores client reference questions and grades saved actual questions and answers', async () => {
  saved.length = 0
  const row = (id: string, role: 'candidate' | 'interviewer', text: string, startMs: number): LiveSegment => ({
    id, sessionId: session.id, speakerId: role, role, confidence: 1, text, startMs, endMs: startMs + 1000, status: 'transcribed',
  })
  saved.push(row('actual-q', 'interviewer', '请介绍项目。', 0), row('actual-a', 'candidate', '我开发了工单平台。', 2000),
    row('actual-a2', 'candidate', '并完成了测试。', 3500), row('later-q', 'interviewer', '什么时候回学校？', 7000))
  const result = await send('POST', '/interview-live-segments/actual-a/analyze', {
    segmentIds: ['actual-a', 'actual-a2'], question: '解释A/B/C请求执行顺序', priorContext: ['伪造的考察背景'],
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(modelInputs.length, 1)
  assert.equal(modelInputs[0]!.question, '请介绍项目。')
  assert.equal(modelInputs[0]!.candidateAnswer, ['我开发了工单平台。', '并完成了测试。'].join(String.fromCharCode(10)))
  assert.ok(!JSON.stringify(modelInputs[0]).includes('回学校'))
  assert.ok(!JSON.stringify(modelInputs[0]).includes('伪造的考察背景'))
  assert.equal(analyses.at(-1)!.question, '请介绍项目。')
  assert.equal(result.body.data.scores[0].score, 7)
  assert.equal(session.currentQuestion, 'Describe your project')
})

test('a reference alone cannot create zero scores when no actual question was captured', async () => {
  saved.splice(0, saved.length, { id: 'unpaired', sessionId: session.id, speakerId: 'candidate', role: 'candidate', confidence: 1,
    text: '我开发了工单平台并完成了测试。', startMs: 2000, endMs: 5000, status: 'transcribed' })
  const count = modelInputs.length
  const result = await send('POST', '/interview-live-segments/unpaired/analyze', { question: '解释A/B/C请求执行顺序' })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.deepEqual(result.body.data.scores, [])
  assert.match(result.body.data.summary, /暂不评分/)
  assert.equal(modelInputs.length, count + 1)
  assert.equal(modelInputs.at(-1)!.question, '')
  assert.equal(analyses.at(-1)!.question, '')
})


test('FunASR failure never calls configured faster-whisper and preserves streaming recovery', async () => {
  process.env.FASTER_WHISPER_BASE_URL = `${process.env.FUNASR_BASE_URL}/fallback`
  process.env.FASTER_WHISPER_TOKEN = 'fallback-test-token'
  upstreamStatus = 503
  try {
    const callsBefore = fallbackCalls
    const savedBefore = saved.length
    const { streamingTranscript: _, ...audioOnly } = payload()
    const response = await send('POST', segmentPath, audioOnly)
    assert.equal(response.status, 502, JSON.stringify(response.body))
    assert.equal(response.body.error.code, 'FUNASR_UPSTREAM')
    assert.equal(fallbackCalls, callsBefore)
    assert.equal(saved.length, savedBefore)
    assert.ok(recordings.size > 0)
    const recovered = await send('POST', segmentPath, payload())
    assert.equal(recovered.status, 201, JSON.stringify(recovered.body))
    assert.equal(fallbackCalls, callsBefore)
    const row = recovered.body.data[0]
    assert.equal(row.text, fullText)
    assert.deepEqual([row.startMs, row.endMs], [15000, 30000])
    assert.equal(row.role, 'unknown')
    assert.ok(row.confidence < .6)
    assert.ok(saved.find(segment => segment.id === row.id))
    assert.equal((await send('POST', `/interview-live-segments/${row.id}/analyze`)).status, 409)
  } finally {
    process.env.FASTER_WHISPER_BASE_URL = ''
    process.env.FASTER_WHISPER_TOKEN = ''
    upstreamStatus = 200
  }
})

test('optional unconfigured fallback is reported separately from failed services', async () => {
  const response = await send('GET', '/ready')
  assert.equal(response.status, 200)
  assert.equal(response.body.data.checks.externalServices.fasterWhisper, 'not_configured')
})

test('separate audio sources persist independent originals and keep overlapping real timestamps on reload', async () => {
  upstreamRows = [{ text: '我完成了测试。', speakerId: 'speaker_0', startMs: 100, endMs: 2200, speakerVerified: true }]
  const before = recordings.size
  const upload = (id: 'microphone' | 'meeting', role: 'candidate' | 'interviewer') => send('POST', segmentPath, {
    audioBase64: Buffer.from('same source bytes').toString('base64'), contentType: 'audio/webm',
    chunkOffsetMs: 100000, chunkEndMs: 101000, audioSource: { id, role, multipleSpeakers: false },
  })
  const meeting = await upload('meeting', 'interviewer')
  const microphone = await upload('microphone', 'candidate')
  assert.equal(meeting.status, 201, JSON.stringify(meeting.body)); assert.equal(microphone.status, 201, JSON.stringify(microphone.body))
  assert.equal(recordings.size, before + 2)
  const tagged = [meeting.body.data[0], microphone.body.data[0]] as LiveSegment[]
  assert.deepEqual(tagged.map(row => row.audioSource), ['meeting', 'microphone'])
  assert.deepEqual(tagged.map(row => row.role), ['interviewer', 'candidate'])
  assert.deepEqual(tagged.map(row => [row.startMs, row.endMs]), [[100100, 101000], [100100, 101000]])
  assert.ok(tagged.every(row => row.confidence === 1))
  const restored = await send('GET', '/interview-live-sessions/checkpoint-session')
  for (const row of tagged) assert.ok(restored.body.data.segments.some((item: LiveSegment) => item.id === row.id && item.audioSource === row.audioSource))
  const originals = await send('GET', '/interviews/' + interviewId + '/recordings')
  const newRows = originals.body.data.filter((row: InterviewAudioRecording) => row.offsetMs === 100000)
  assert.equal(newRows.length, 2)
  assert.ok(newRows.every((row: InterviewAudioRecording) => row.endMs === 101000 && row.sourceMultipleSpeakers === false))
})

test('source recovery retains provenance without inventing a role and never calls faster-whisper', async () => {
  upstreamStatus = 503
  const before = fallbackCalls
  try {
    const response = await send('POST', segmentPath, { ...payload(), chunkEndMs: 30000,
      audioSource: { id: 'meeting', role: 'candidate', multipleSpeakers: true },
      streamingTranscript: { text: fullText, endMs: 30000, complete: true, audioSource: 'meeting' },
    })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    assert.ok(response.body.data.length)
    assert.ok(response.body.data.every((row: LiveSegment) => row.audioSource === 'meeting' && row.role === 'unknown'))
    assert.equal(response.body.data.map((row: LiveSegment) => row.text).join(''), fullText)
    assert.equal(fallbackCalls, before)
  } finally { upstreamStatus = 200 }
})

test('rejects mismatched provenance and invalid source timelines before ASR or original storage', async () => {
  const calls = upstreamCalls, count = recordings.size
  const valid = { ...payload(), chunkEndMs: 30000, audioSource: { id: 'microphone', role: 'unknown', multipleSpeakers: true } }
  for (const body of [valid,
    { ...valid, streamingTranscript: { text: fullText, complete: true, endMs: 30000, audioSource: 'meeting' } },
    { ...valid, streamingTranscript: { text: fullText, complete: true, endMs: 29999, audioSource: 'microphone' } },
    { ...valid, streamingTranscript: undefined, chunkEndMs: undefined },
    { ...valid, streamingTranscript: undefined, chunkOffsetMs: 15000.5 },
    { ...valid, streamingTranscript: undefined, chunkEndMs: 15000 },
    { ...valid, streamingTranscript: undefined, audioSource: { ...valid.audioSource, id: 'mixed' } },
  ]) {
    const response = await send('POST', segmentPath, body)
    assert.equal(response.status, 400, JSON.stringify(response.body))
  }
  assert.equal(upstreamCalls, calls); assert.equal(recordings.size, count)
})

test('manual refinement endpoint authenticates, validates and forwards the source snapshot and actor', async () => {
  const segment = saved[0]!
  const path = `/interview-live-segments/${segment.id}/refinement`
  const sourceSegments = [{ id: segment.id, text: segment.text, role: segment.role, speakerId: segment.speakerId }]
  const input = { text: '手动微调后的发言。', expectedText: '模型整理后的发言。', sourceSegments }
  const refinement = { text: input.text, corrections: [], uncertainties: [], editedAt: new Date().toISOString(), editedBy: 'test-actor' }
  const update = mock.method(LiveInterviewSessionRepository.prototype, 'updateRefinement', async (...[id, body, actorId]: Parameters<LiveInterviewSessionRepository['updateRefinement']>) => {
    assert.equal(id, segment.id)
    assert.deepEqual(body, input)
    assert.ok(actorId)
    return refinement
  })
  try {
    assert.equal((await send('POST', path, input, { authorization: '' })).status, 401)
    assert.equal((await send('POST', path, input, { 'x-csrf-token': '' })).status, 403)
    for (const invalid of [
      { ...input, text: ' ' }, { ...input, text: 'a'.repeat(50001) },
      { ...input, expectedText: '' }, { ...input, sourceSegments: [] },
      { ...input, sourceSegments: [...sourceSegments, ...sourceSegments] },
      { ...input, sourceSegments: [{ ...sourceSegments[0], speakerId: null }] },
      { ...input, sourceSegments: [{ ...sourceSegments[0], id: 'other-segment' }] },
    ]) assert.equal((await send('POST', path, invalid)).status, 400)
    assert.equal(update.mock.callCount(), 0)
    const result = await send('POST', path, input)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.deepEqual(result.body.data, refinement)
    assert.equal(update.mock.callCount(), 1)
  } finally { update.mock.restore() }
})

test('manual refinement endpoint preserves conflict responses without overwriting text', async () => {
  const segment = saved[0]!
  const update = mock.method(LiveInterviewSessionRepository.prototype, 'updateRefinement', async () => {
    throw Object.assign(new Error('发言已更新，请刷新后重新编辑。'), { status: 409, code: 'TRANSCRIPT_REFINEMENT_CONFLICT' })
  })
  try {
    const result = await send('POST', `/interview-live-segments/${segment.id}/refinement`, {
      text: '微调后的发言', expectedText: '旧版发言',
      sourceSegments: [{ id: segment.id, text: segment.text, role: segment.role, speakerId: segment.speakerId }],
    })
    assert.equal(result.status, 409, JSON.stringify(result.body))
    assert.equal(result.body.error.code, 'TRANSCRIPT_REFINEMENT_CONFLICT')
    assert.equal(update.mock.callCount(), 1)
  } finally { update.mock.restore() }
})
