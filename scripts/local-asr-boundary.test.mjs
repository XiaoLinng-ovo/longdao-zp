import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { decodeAudioEvidence, startLocalAsrBoundary, syntheticMicrophoneWav, syntheticTranscript } from './local-asr-boundary.mjs'

test('合成输入由真实 FFmpeg 解码，静音不能冒充成功', async () => {
  const evidence = await decodeAudioEvidence(syntheticMicrophoneWav(1))
  assert.equal(evidence.durationMs, 1000); assert.ok(evidence.rms > 100)
  const silent = syntheticMicrophoneWav(1); silent.fill(0, 44)
  await assert.rejects(decodeAudioEvidence(silent), /静音/)
})

test('本机 ASR 校验实际音频，故障只影响下一次调用', async () => {
  const boundary = await startLocalAsrBoundary({ token: 'isolated-token' })
  try {
    const url = 'http://127.0.0.1:' + boundary.port + '/transcribe'
    const headers = { authorization: 'Bearer isolated-token', 'content-type': 'audio/wav' }
    assert.equal((await fetch(url, { headers })).status, 405)
    boundary.setAvailable(false); assert.equal((await fetch(url, { headers })).status, 503)
    boundary.setAvailable(true); assert.equal((await fetch(url, { headers })).status, 405)
    const call = () => fetch(url, { method: 'POST', headers, body: syntheticMicrophoneWav(1) })
    assert.equal((await (await call()).json()).segments[0].text, syntheticTranscript)
    boundary.failNextTranscription(); assert.equal((await call()).status, 503)
    assert.equal((await call()).status, 200)
    assert.equal(boundary.requests.length, 3); assert.deepEqual(boundary.failures, [])
  } finally { await boundary.close() }
})

test('流式边界真实接收非静音 PCM 并确认 commit，不替代业务鉴权', async () => {
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
  const { WebSocket } = require('ws')
  const boundary = await startLocalAsrBoundary({ token: 'isolated-token' })
  const client = new WebSocket('ws://127.0.0.1:' + boundary.port + '/stream', { headers: { authorization: 'Bearer isolated-token' } })
  const messages = []; client.on('message', data => messages.push(JSON.parse(data)))
  try {
    await once(client, 'open')
    client.send(syntheticMicrophoneWav(1).subarray(44))
    const next = once(client, 'message'); client.send(JSON.stringify({ type: 'commit', commitId: 'synthetic-commit' })); await next
    const deadline = Date.now() + 3000
    while (!messages.some(message => message.commitId === 'synthetic-commit')) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)) }
    assert.equal(boundary.streams[0].nonSilent, true); assert.deepEqual(boundary.failures, [])
  } finally { client.terminate(); await boundary.close() }
})
