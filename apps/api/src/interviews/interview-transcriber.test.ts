import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { transcribeInterviewChunk } from './interview-transcriber.js'
import { FunAsrError } from './funasr-client.js'
import { mapInterviewRoles } from './role-mapper.js'

const primaryUrl = 'http://primary.test/transcribe'
const fallbackUrl = 'http://fallback.test/transcribe'
const env = { FUNASR_BASE_URL: primaryUrl, FASTER_WHISPER_BASE_URL: fallbackUrl, FASTER_WHISPER_TOKEN: 'test-token' }
const audio = new Uint8Array([1, 2, 3])
const rows = [{ speakerId: 'speaker_0', text: '我负责平台开发。', startMs: 0, endMs: 300000, speakerVerified: false, speakerMixed: true }]
const json = (segments: unknown[]) => Response.json({ segments })

describe('FunASR-only interview transcription', () => {
  it('keeps successful primary results, including silence, without sending audio twice', async () => {
    for (const segments of [rows, []]) {
      const calls: string[] = []
      const result = await transcribeInterviewChunk(audio, 'audio/webm', env, async input => {
        calls.push(String(input))
        return json(segments)
      })
      assert.equal(result.length, segments.length)
      assert.deepEqual(calls, [primaryUrl])
    }
  })

  it('preserves audio, content type, token, timestamps and unverified roles', async () => {
    const result = await transcribeInterviewChunk(audio, 'audio/webm;codecs=opus', { ...env, FUNASR_TOKEN: 'funasr-token' }, async (input, init) => {
      assert.equal(String(input), primaryUrl)
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer funasr-token')
      assert.equal(new Headers(init?.headers).get('content-type'), 'audio/webm;codecs=opus')
      assert.deepEqual(init?.body, Buffer.from(audio))
      return json(rows)
    })
    assert.equal(result[0]?.endMs, 300000)
    assert.equal(mapInterviewRoles(result, {})[0]?.role, 'unknown')
  })

  it('does not fall back on HTTP, network or invalid response failures even when configured', async () => {
    for (const failure of ['http', 'network', 'payload']) {
      const calls: string[] = []
      await assert.rejects(transcribeInterviewChunk(audio, 'audio/webm;codecs=opus', env, async input => {
        calls.push(String(input))
        if (failure === 'network') throw new TypeError('fetch failed')
        return failure === 'http' ? new Response('', { status: 503 }) : Response.json({ invalid: true })
      }), (error: unknown) => error instanceof FunAsrError && error.code === (failure === 'payload' ? 'INVALID_RESPONSE' : 'UPSTREAM'))
      assert.deepEqual(calls, [primaryUrl])
    }
  })

  it('rejects missing or invalid FunASR configuration without contacting any recognizer', async () => {
    for (const config of [{ FASTER_WHISPER_BASE_URL: fallbackUrl }, { ...env, FUNASR_BASE_URL: 'invalid' }, { ...env, FUNASR_TIMEOUT_MS: '0' }, {}]) {
      const calls: string[] = []
      await assert.rejects(transcribeInterviewChunk(audio, 'audio/webm', config, async input => {
        calls.push(String(input)); return json(rows)
      }), (error: unknown) => error instanceof FunAsrError && error.code === 'NOT_CONFIGURED')
      assert.deepEqual(calls, [])
    }
  })
})
