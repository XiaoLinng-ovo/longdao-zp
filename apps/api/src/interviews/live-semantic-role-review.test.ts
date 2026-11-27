import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLiveSemanticRoleReviewer, type HistoricalRoleReview } from './live-semantic-role-review.js'
import type { LiveSegment } from './live-session-repository.js'
import type { RoleMapping } from './role-mapper.js'
import { SemanticRoleReviewer } from './semantic-role-review.js'

const env = { OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'synthetic', OPENAI_MODEL: 'test' }
const history = (id: string, endMs = 1000): LiveSegment => ({ id, sessionId: 'session', role: 'unknown', confidence: .35,
  text: '就是客服 Agent 的时候，', speakerId: 'microphone:voice_1', audioSource: 'microphone',
  startMs: endMs - 900, endMs, status: 'transcribed', roleReview: { method: 'semantic_context', status: 'uncertain',
    confidence: .4, reason: '片段尚不完整', model: 'test', promptVersion: 'test' } })
const current: RoleMapping = { id: 'new', role: 'unknown', confidence: .35, reasons: [], speakerId: 'microphone:voice_1',
  text: '我负责了这个项目的需求、开发和上线。', startMs: 3000, endMs: 6000, audioSource: 'microphone' }

function reviewer(capture: (input: Record<string, any>) => void = () => {}, uncertain = false) {
  return new SemanticRoleReviewer(async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
    capture(input)
    return Response.json({ choices: [{ message: { content: JSON.stringify({ turns: input.turnsToReview.map((turn: { turnId: string }) => ({
      turnId: turn.turnId, role: uncertain ? 'unknown' : 'candidate', confidence: uncertain ? .4 : .95,
      mixed: false, reason: uncertain ? '仍无法确定角色' : '后续完整回答明确了此前项目片段的归属',
    })) }) } }] })
  })
}

test('new context re-reviews earlier semantic uncertainty and persists only resolved historical roles', async () => {
  const previous = history('old'), snapshot = structuredClone(previous)
  const saved: HistoricalRoleReview[] = [], inputs: Record<string, any>[] = []
  const review = createLiveSemanticRoleReviewer(async () => env, reviewer(input => inputs.push(input)), async (session, changes) => {
    assert.equal(session, 'session'); saved.push(...changes)
  })
  const result = await review('session', [current], [previous])
  assert.deepEqual(inputs[0]!.turnsToReview.map((turn: { turnId: string }) => turn.turnId), ['old', 'new'])
  assert.equal(inputs[0]!.after.length, 0)
  assert.equal(saved.length, 1)
  assert.equal(saved[0]?.after.role, 'candidate')
  assert.equal(saved[0]?.after.roleReview?.failure, undefined)
  assert.deepEqual(result.map(turn => turn.id), ['new'])
  assert.equal(result[0]?.role, 'candidate')
  assert.deepEqual(previous, snapshot)
  assert.equal(saved[0]?.after.speakerId, previous.speakerId)
  assert.equal(saved[0]?.after.startMs, previous.startMs)
  assert.notEqual(saved[0]?.after.speakerConfirmed, true)
})

test('historical targets are bounded and exclude manual, resolved, other-session and overlapping speech', async () => {
  let targets: string[] = []
  const rows = Array.from({ length: 10 }, (_, index) => history('old-' + index, (index + 1) * 200))
  const excluded: LiveSegment[] = [history('expired', -100000), { ...history('manual'), role: 'candidate', speakerConfirmed: true },
    { ...history('resolved'), role: 'candidate', confidence: .95, roleReview: { ...history('x').roleReview!, status: 'inferred', confidence: .95 } },
    { ...history('other'), sessionId: 'other-session' }, history('overlapping', 4000)]
  const review = createLiveSemanticRoleReviewer(async () => env, reviewer(input => {
    targets = input.turnsToReview.map((turn: { turnId: string }) => turn.turnId)
  }), async () => {})
  await review('session', [current], [...rows, ...excluded])
  assert.deepEqual(targets, ['old-6', 'old-7', 'old-8', 'old-9', 'new'])
})

test('remaining uncertainty is not persisted as a confirmed role or propagated by speaker id', async () => {
  let saves = 0
  const review = createLiveSemanticRoleReviewer(async () => env, reviewer(undefined, true), async () => { saves++ })
  const result = await review('session', [current], [history('old')])
  assert.equal(saves, 0); assert.equal(result[0]?.role, 'unknown')
  assert.equal(result[0]?.roleReview?.status, 'uncertain')
  assert.equal(result[0]?.roleReview?.failure, undefined)
})

test('historical retries never add a model batch ahead of current speech', async () => {
  let calls = 0
  const review = createLiveSemanticRoleReviewer(async () => env, reviewer(input => {
    calls++; assert.equal(input.turnsToReview.length, 8)
    assert.ok(input.turnsToReview.every((row: { turnId: string }) => row.turnId.startsWith('current-')))
  }), async () => { throw Error('must not persist') })
  const result = await review('session', Array.from({ length: 8 }, (_, index) => ({ ...current, id: 'current-' + index })), [history('old')])
  assert.equal(calls, 1); assert.equal(result.length, 8)
})

test('history persistence failures never lose the newly recognized audio segment', async () => {
  const review = createLiveSemanticRoleReviewer(async () => env, reviewer(), async () => { throw Error('unavailable') })
  const result = await review('session', [current], [history('old')])
  assert.equal(result[0]?.id, 'new'); assert.equal(result[0]?.role, 'candidate')
})

test('missing enterprise authorization never reuses global credentials or confirms historical speech', async () => {
  let saves = 0
  const review = createLiveSemanticRoleReviewer(async () => { throw Error('not authorized') },
    new SemanticRoleReviewer(async () => { throw Error('must not call') }), async () => { saves++ })
  const result = await review('session', [current], [history('old')])
  assert.equal(saves, 0); assert.equal(result[0]?.roleReview?.failure, 'configuration')
  assert.equal(result[0]?.role, 'unknown')
})
