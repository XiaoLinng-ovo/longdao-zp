import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLiveInterviewAudioStorage } from './live-audio-storage.js'

describe('live interview audio storage', () => {
  it('stores every audio chunk under a private session-scoped object key', async () => {
    const writes: Array<{ key: string; body: Uint8Array; contentType: string }> = []
    const storage = createLiveInterviewAudioStorage({
      async put(key, body, contentType) { writes.push({ key, body, contentType }) },
      async get() { return Buffer.alloc(0) },
      async delete() {},
      async health() { return true },
      kind: 'local',
    })

    const key = await storage.store('11111111-1111-4111-8111-111111111111', new Uint8Array([1, 2, 3]), 'audio/webm', 1000)

    assert.match(key, /^interviews\/11111111-1111-4111-8111-111111111111\/audio\/1000-[0-9a-f]{64}\.webm$/)
    assert.deepEqual(writes, [{ key, body: new Uint8Array([1, 2, 3]), contentType: 'audio/webm' }])
  })

  it('uses a safe fallback extension for unrecognized content types', async () => {
    const writes: string[] = []
    const storage = createLiveInterviewAudioStorage({
      async put(key) { writes.push(key) },
      async get() { return Buffer.alloc(0) },
      async delete() {},
      async health() { return true },
      kind: 'local',
    })

    await storage.store('session', new Uint8Array(), 'application/octet-stream', 0)

    assert.match(writes[0]!, /\.bin$/)
  })

  it('keeps exact original bytes and reuses the same key only for the same session, offset and audio', async () => {
    const objects = new Map<string, Buffer>()
    const storage = createLiveInterviewAudioStorage({ kind: 'local',
      async put(key, body) { objects.set(key, Buffer.from(body)) },
      async get(key) { return objects.get(key)! }, async delete() {}, async health() { return true },
    })
    const audio = new Uint8Array([0, 255, 7, 128])
    const key = await storage.store('s', audio, 'audio/webm;codecs=opus', 1000)
    assert.equal(await storage.store('s', audio, 'audio/webm;codecs=opus', 1000), key)
    assert.match(key, /\.webm$/); assert.deepEqual(await storage.read(key), Buffer.from(audio))
    const mic = await storage.store('s', audio, 'audio/webm', 1000, 'microphone')
    const meeting = await storage.store('s', audio, 'audio/webm', 1000, 'meeting')
    assert.notEqual(mic, meeting); assert.notEqual(mic, key)
    assert.ok(mic.includes('/audio/microphone/1000-'))
    assert.equal(await storage.store('s', audio, 'audio/webm', 1000, 'microphone'), mic)
    assert.notEqual(await storage.store('s', audio, 'audio/webm', 2000), key)
    assert.notEqual(await storage.store('other', audio, 'audio/webm', 1000), key)
    assert.notEqual(await storage.store('s', new Uint8Array([1]), 'audio/webm', 1000), key)
  })
})
