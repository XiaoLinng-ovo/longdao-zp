import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createFunAsrClient, FunAsrError, loadFunAsrConfig, probeFunAsrService } from './funasr-client.js'
import { mapInterviewRoles } from './role-mapper.js'

describe('FunASR client', () => {
  it('maps anonymous speaker segments from a compatible response', async () => {
    const client = createFunAsrClient({ baseUrl: 'http://asr.local/transcribe', timeoutMs: 1000 }, async () => new Response(JSON.stringify({ segments: [{ spk: 0, sentence: '请自我介绍', start: 0, end: 1200 }] }), { status: 200 }))
    assert.deepEqual(await client.transcribe(new Uint8Array([1, 2])), [{ id: 'speaker_0:0', speakerId: 'speaker_0', text: '请自我介绍', startMs: 0, endMs: 1200, speakerVerified: false }])
  })
  it('fails closed for missing configuration and invalid upstream payloads', async () => {
    assert.throws(() => loadFunAsrConfig({}), (error: unknown) => error instanceof FunAsrError && error.code === 'NOT_CONFIGURED')
    const client = createFunAsrClient({ baseUrl: 'http://asr.local', timeoutMs: 1000 }, async () => new Response('{}', { status: 200 }))
    await assert.rejects(client.transcribe(new Uint8Array([1])), (error: unknown) => error instanceof FunAsrError && error.code === 'INVALID_RESPONSE')
  })

  it('probes network reachability without requiring a successful HTTP method', async () => {
    let requested = ''
    const reachable = await probeFunAsrService(
      { baseUrl: 'http://asr.local/transcribe', timeoutMs: 1000 },
      async (input: string | URL | Request) => {
        requested = String(input)
        return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 })
      },
    )
    assert.equal(reachable, true)
    assert.equal(requested, 'http://asr.local/transcribe')

    const unreachable = await probeFunAsrService(
      { baseUrl: 'http://asr.local/transcribe', timeoutMs: 1000 },
      async () => { throw new TypeError('fetch failed') },
    )
    assert.equal(unreachable, false)
  })

  it('retains acoustic failure and mixed-speaker flags instead of silently trusting text guesses', async () => {
    const client = createFunAsrClient({ baseUrl: 'http://asr.local', timeoutMs: 1000 }, async () => new Response(JSON.stringify({ segments: [
      { spk: 0, text: '我负责系统开发。', start: 0, end: 2000, speakerVerified: false, speakerMixed: true, speakerEmbedding: [1, 0] },
      { spk: 1, text: '请介绍。', start: 2000, end: 3000, speakerVerified: true, speakerEmbedding: [0, 0] },
    ] })))
    const rows = await client.transcribe(new Uint8Array([1]))
    assert.equal(rows[0]?.speakerVerified, false)
    assert.equal(rows[0]?.speakerMixed, true)
    assert.deepEqual(rows[0]?.speakerEmbedding, [1, 0])
    assert.equal(rows[1]?.speakerVerified, true)
    assert.equal(rows[1]?.speakerEmbedding, undefined)
  })
  it('does not infer or inherit a role when upstream omitted acoustic verification', async () => {
    const client = createFunAsrClient({ baseUrl: 'http://asr.local', timeoutMs: 1000 }, async () => new Response(JSON.stringify({ segments: [
      { spk: 0, text: '我负责平台开发。', start: 0, end: 2000 },
    ] })))
    const rows = await client.transcribe(new Uint8Array([1]))
    for (const confirmed of [{}, { speaker_0: 'candidate' as const }]) {
      assert.equal(mapInterviewRoles(rows, confirmed, { speaker_0: 'candidate' })[0]?.role, 'unknown')
    }
  })
})
