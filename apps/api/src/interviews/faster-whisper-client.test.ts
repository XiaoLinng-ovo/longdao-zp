import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createFasterWhisperClient, FasterWhisperError, loadFasterWhisperConfig, probeFasterWhisperService } from './faster-whisper-client.js'

describe('faster-whisper client', () => {
  it('maps the service response and marks a single-speaker fallback normally', async () => {
    const client = createFasterWhisperClient({ baseUrl: 'http://asr.local/transcribe', timeoutMs: 1000 }, async () => new Response(JSON.stringify({ segments: [{ speakerId: 'speaker_0', text: '我负责平台开发。', startMs: 0, endMs: 1200, speakerVerified: false, speakerMixed: true }] }), { status: 200 }))
    assert.deepEqual(await client.transcribe(new Uint8Array([1])), [{ id: 'speaker_0:0', speakerId: 'speaker_0', text: '我负责平台开发。', startMs: 0, endMs: 1200, speakerVerified: false, speakerMixed: true }])
  })
  it('fails closed for invalid configuration and invalid payloads', async () => {
    assert.throws(() => loadFasterWhisperConfig({}), (error: unknown) => error instanceof FasterWhisperError && error.code === 'NOT_CONFIGURED')
    const client = createFasterWhisperClient({ baseUrl: 'http://asr.local', timeoutMs: 1000 }, async () => new Response('{}', { status: 200 }))
    await assert.rejects(client.transcribe(new Uint8Array([1])), (error: unknown) => error instanceof FasterWhisperError && error.code === 'INVALID_RESPONSE')
  })
  it('probes the optional service without requiring a transcription request', async () => {
    let requested = ''
    const healthy = await probeFasterWhisperService({ baseUrl: 'http://asr.local/transcribe', timeoutMs: 1000 }, async (input: string | URL | Request) => { requested = String(input); return new Response('{}', { status: 200 }) })
    assert.equal(healthy, true)
    assert.equal(requested, 'http://asr.local/health')
  })
})
