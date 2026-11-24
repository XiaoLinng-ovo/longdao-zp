import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SemanticRoleReviewer, semanticRoleResolved, type SemanticRoleTurn } from './semantic-role-review.js'
import { transcriptRoleReviewWarning, rawSegmentsToEvidence, rawSnapshotFingerprint } from './transcript-postprocessing.js'
import { createLiveSemanticRoleReviewer } from './live-semantic-role-review.js'

const env = { OPENAI_BASE_URL: 'https://model.test/v1', OPENAI_API_KEY: 'test', OPENAI_MODEL: 'test-model' }
test('raw evidence and fingerprint preserve semantic review provenance', () => {
  const row = { id: 'raw', text: '项目回答', speakerId: 'shared', role: 'candidate' as const,
    confidence: .95, startMs: 0, endMs: 1000 }
  const reviewed = { ...row, roleReview: { method: 'semantic_context' as const, status: 'inferred' as const,
    confidence: .95, reason: '承接项目问题', model: 'test', promptVersion: 'v1' } }
  assert.deepEqual(rawSegmentsToEvidence([reviewed])[0]?.roleReview, reviewed.roleReview)
  assert.notEqual(rawSnapshotFingerprint([row], []), rawSnapshotFingerprint([reviewed], []))
})
const turn = (id: string, text: string, extra: Partial<SemanticRoleTurn> = {}): SemanticRoleTurn => ({
  id, text, role: 'unknown', confidence: .35, speakerId: 'meeting:chunk_0:speaker_0',
  startMs: Number(id) * 1000, endMs: Number(id) * 1000 + 900, ...extra,
})
const decision = (turnId: string, role = 'candidate', extra: Record<string, unknown> = {}) => ({
  turnId, role, confidence: .94, mixed: false, reason: '承接上一轮关于本人项目的问题', ...extra,
})
function model(items: unknown[], capture?: (body: Record<string, any>) => void) {
  return new SemanticRoleReviewer(async (_url, init) => {
    capture?.(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ turns: items }) } }] })
  })
}

test('semantic roles distinguish candidate questions and interviewer introductions despite one shared speaker id', async () => {
  const input = [turn('1', '贵公司的岗位入职后主要负责什么？', { role: 'interviewer', confidence: .82 }),
    turn('2', '我们团队目前在做招聘系统，我之前也负责过技术架构。', { role: 'candidate', confidence: .82 })]
  let request: Record<string, any> = {}
  const result = await model([decision('1'), decision('2', 'interviewer')], body => { request = body }).review(input, env)
  assert.deepEqual(result.turns.map(row => row.role), ['candidate', 'interviewer'])
  assert.equal(result.warnings.length, 0)
  for (const [index, row] of result.turns.entries()) {
    assert.equal(row.text, input[index]?.text)
    assert.equal(row.speakerId, input[index]?.speakerId)
    assert.equal(row.startMs, input[index]?.startMs)
    assert.equal(row.endMs, input[index]?.endMs)
    assert.notEqual(row.speakerConfirmed, true)
    assert.equal(row.roleReview?.method, 'semantic_context')
  }
  assert.equal(input[0]?.role, 'interviewer')
  assert.match(request.messages[0].content, /不能根据问号/)
  assert.match(request.messages[0].content, /不可信/)
})

test('recent context and future context are sent without rewriting a manually confirmed turn', async () => {
  let request: Record<string, any> = {}
  const history = [turn('0', '项目用了哪些技术？', { role: 'interviewer', speakerConfirmed: true })]
  const confirmed = turn('2', '我是本次面试官。', { role: 'interviewer', speakerConfirmed: true, confidence: 1 })
  const result = await model([decision('1')], body => { request = JSON.parse(body.messages[1].content) })
    .review([turn('1', 'Python和向量数据库。'), confirmed], env, { history })
  assert.equal(request.before[0].turnId, '0')
  assert.equal(request.trustedAnchors.length, 2)
  assert.deepEqual(request.turnsToReview.map((row: any) => row.turnId), ['1'])
  assert.deepEqual(result.turns[1], confirmed)
})

test('low confidence, acknowledgements and mixed turns remain unresolved without invented boundaries', async () => {
  const input = [turn('1', '嗯。'), turn('2', '你负责什么？我负责后端。')]
  const result = await model([decision('1', 'candidate', { confidence: .6 }), decision('2', 'interviewer', { mixed: true })]).review(input, env)
  assert.deepEqual(result.turns.map(row => row.role), ['unknown', 'unknown'])
  assert.deepEqual(result.turns.map(row => row.roleReview?.status), ['uncertain', 'mixed'])
  assert.deepEqual(result.turns.map(row => row.text), input.map(row => row.text))
  assert.ok(result.turns.every(row => !semanticRoleResolved(row)))
})

for (const [name, items] of Object.entries({
  missing: [], duplicate: [decision('1'), decision('1')], invented: [decision('other')],
  numericString: [decision('1', 'candidate', { confidence: '0.99' })],
  outOfRange: [decision('1', 'candidate', { confidence: 2 })],
  invalidRole: [decision('1', 'manager')], missingReason: [decision('1', 'candidate', { reason: '' })],
})) {
  test('rejects malformed semantic output: ' + name, async () => {
    const result = await model(items).review([turn('1', '我负责后端。', { role: 'candidate' })], env)
    assert.equal(result.turns[0]?.role, 'unknown')
    assert.equal(result.turns[0]?.roleReview?.status, 'uncertain')
    assert.equal(result.warnings.length, 1)
  })
}

test('provider failure and reasoning-only output cannot certify roles', async () => {
  for (const fetchImpl of [async () => { throw new Error('timeout') },
    async () => Response.json({ choices: [{ message: { reasoning_content: JSON.stringify({ turns: [decision('1')] }) } }] })]) {
    const result = await new SemanticRoleReviewer(fetchImpl).review([turn('1', '我做过项目。')], env)
    assert.equal(result.turns[0]?.roleReview?.status, 'uncertain')
    assert.equal(result.turns[0]?.role, 'unknown')
  }
})

test('missing config never calls a provider or marks heuristic roles as reviewed', async () => {
  const reviewer = new SemanticRoleReviewer(async () => { throw Error('must not call') })
  const input = [turn('1', '我做过项目。')]
  const result = await reviewer.review(input, {})
  assert.deepEqual(result.turns, input)
  assert.equal(result.warnings.length, 1)
  assert.equal(result.turns[0]?.roleReview, undefined)
})

test('batches preserve coverage and heartbeat; lookahead never becomes a target twice', async () => {
  const targets: string[] = [], counts: number[] = []
  let heartbeats = 0
  const reviewer = new SemanticRoleReviewer(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content)
    targets.push(...data.turnsToReview.map((row: any) => row.turnId)); counts.push(data.turnsToReview.length)
    return Response.json({ choices: [{ message: { content: JSON.stringify({ turns: data.turnsToReview.map((row: any) => decision(row.turnId)) }) } }] })
  })
  const result = await reviewer.review(Array.from({ length: 51 }, (_, i) => turn(String(i), '我负责后端。')), env,
    { heartbeat: async () => { heartbeats++ } })
  assert.deepEqual(counts, [8, 8, 8, 8, 8, 8, 3]); assert.equal(new Set(targets).size, 51)
  assert.equal(heartbeats, 14); assert.ok(result.turns.every(semanticRoleResolved))
})

test('live adapter uses session config and preserves semantic provenance', async () => {
  // A confidence of one remains automatic and cannot become an acoustic identity vote.
  let resolved = ''
  const review = createLiveSemanticRoleReviewer(async session => { resolved = session; return env }, model([decision('1')]))
  const result = await review('session-1', [{ ...turn('1', '贵公司有培训吗？'), reasons: [] }], [])
  assert.equal(resolved, 'session-1'); assert.equal(result[0]?.role, 'candidate')
  assert.equal(result[0]?.roleReview?.status, 'inferred')
})

test('orders and deduplicates context, carrying prior review status without changing output order', async () => {
  const requests: Array<Record<string, any>> = []
  const input = Array.from({ length: 10 }, (_, i) => turn(String(i), '个人项目说明', { role: 'interviewer' })).reverse()
  const reviewer = new SemanticRoleReviewer(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
    requests.push(data)
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      turns: data.turnsToReview.map((row: any) => decision(row.turnId, 'candidate', { mixed: row.turnId === '0' })),
    }) } }] })
  })
  const result = await reviewer.review(input, env, { history: [
    turn('1', '过期上下文', { role: 'interviewer' }), turn('-1', '前文'), turn('-1', '重复前文'),
  ] })
  assert.deepEqual(requests[0]!.turnsToReview.map((row: any) => row.turnId), ['0', '1', '2', '3', '4', '5', '6', '7'])
  const before = requests[1]!.before
  assert.equal(new Set(before.map((row: any) => row.turnId)).size, before.length)
  assert.equal(before.find((row: any) => row.turnId === '0').roleReview.status, 'mixed')
  assert.equal(before.find((row: any) => row.turnId === '0').previousRole, 'unknown')
  assert.equal(before.find((row: any) => row.turnId === '1').previousRole, 'candidate')
  assert.equal(before.find((row: any) => row.turnId === '1').text, '个人项目说明')
  assert.deepEqual(result.turns.map(row => row.id), input.map(row => row.id))
  assert.ok(input.every(row => row.role === 'interviewer' && !row.roleReview))
})

test('offline truncated batches split once while realtime failures never multiply requests', async () => {
  for (const realtime of [false, true]) {
    let calls = 0
    const reviewer = new SemanticRoleReviewer(async (_url, init) => {
      calls++
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
      if (data.turnsToReview.length > 2) return Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })
      return Response.json({ choices: [{ message: { content: JSON.stringify({ turns: data.turnsToReview.map((row: any) => decision(row.turnId)) }) } }] })
    })
    const result = await reviewer.review(Array.from({ length: 4 }, (_, i) => turn(String(i), '我的项目经历')), env, realtime ? { timeoutMs: 12000 } : {})
    assert.equal(calls, realtime ? 1 : 3)
    assert.equal(result.warnings.length, realtime ? 1 : 0)
    assert.ok(result.turns.every(row => realtime ? row.role === 'unknown' : semanticRoleResolved(row)))
  }
})

test('semantic role inference resolves role review without pretending human confirmation', async () => {
  const result = await model([decision('1')]).review([turn('1', '我负责后端。')], env)
  const manifest = [{ offsetMs: 0, endMs: 9000, sourceMultipleSpeakers: true }] as Parameters<typeof transcriptRoleReviewWarning>[0]
  const turns = result.turns.map(row => ({ ...row, roleReasons: [], evidenceIds: ['original'] }))
  assert.equal(transcriptRoleReviewWarning(manifest, turns), undefined)
  assert.notEqual(turns[0]?.speakerConfirmed, true)
  assert.match(transcriptRoleReviewWarning(manifest, [{ ...turns[0]!, role: 'unknown' }]) ?? '', /暂不评分/)
})
