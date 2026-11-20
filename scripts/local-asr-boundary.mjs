import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const { WebSocketServer } = require('ws')
export const syntheticTranscript = '你好'

export function syntheticMicrophoneWav(seconds = 30) {
  const samples = Math.round(seconds * 16000)
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36)
  wav.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) {
    const t = i / 16000
    wav.writeInt16LE(Math.round(7000 * Math.sin(2 * Math.PI * (220 * t + 25 * t * t))), 44 + i * 2)
  }
  return wav
}

export function pcmEvidence(pcm) {
  assert.ok(pcm.length >= 320 && pcm.length % 2 === 0, '必须接收到真实非空 PCM')
  let sum = 0, peak = 0
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i)
    sum += sample * sample; peak = Math.max(peak, Math.abs(sample))
  }
  const rms = Math.sqrt(sum / (pcm.length / 2))
  assert.ok(peak > 100 && rms > 20, '实际音频不能是空白或静音')
  return { bytes: pcm.length, durationMs: pcm.length / 32, peak, rms }
}

export async function decodeAudioEvidence(audio) {
  const pcm = await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const output = [], errors = []; let size = 0, timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 15000)
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) child.kill(); else output.push(chunk) })
    child.stderr.on('data', chunk => errors.push(chunk))
    child.stdin.on('error', () => {})
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code !== 0 || timedOut || size > 16 * 1024 * 1024) reject(new Error('真实 FFmpeg 解码失败：' + Buffer.concat(errors).toString('utf8')))
      else resolve(Buffer.concat(output))
    })
    child.stdin.end(audio)
  })
  return pcmEvidence(pcm)
}

export async function startLocalAsrBoundary({ token }) {
  const requests = [], streams = [], failures = [], active = new Set()
  let failNext = false, available = true
  const server = createServer((request, response) => {
    const work = (async () => {
      try {
        assert.equal(request.url, '/transcribe')
        assert.equal(request.headers.authorization, 'Bearer ' + token)
        if (request.method === 'GET') { response.writeHead(available ? 405 : 503); response.end(); return }
        assert.equal(request.method, 'POST')
        assert.match(request.headers['content-type'] || '', /^(audio\/|application\/octet-stream)/)
        let size = 0; const chunks = []
        for await (const chunk of request) { size += chunk.length; assert.ok(size <= 8 * 1024 * 1024); chunks.push(chunk) }
        const evidence = await decodeAudioEvidence(Buffer.concat(chunks))
        const unavailable = failNext; failNext = false
        requests.push({ contentType: request.headers['content-type'], inputBytes: size, ...evidence, injectedUnavailable: unavailable })
        response.writeHead(unavailable ? 503 : 200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(unavailable ? { error: '本机合成边界故障' } : { segments: [{ speakerId: 'synthetic_speaker', text: syntheticTranscript, startMs: 0, endMs: Math.min(1000, evidence.durationMs) }] }))
      } catch (error) {
        failures.push(error.message)
        response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: '本机语音边界拒绝' }))
      }
    })()
    active.add(work); void work.finally(() => active.delete(work))
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/stream' || request.headers.authorization !== 'Bearer ' + token) {
      failures.push('流式请求未通过路径或凭据校验'); socket.destroy(); return
    }
    wss.handleUpgrade(request, socket, head, client => {
      const record = { bytes: 0, frames: 0, commits: 0, nonSilent: false }; streams.push(record)
      client.send(JSON.stringify({ type: 'status', status: 'ready', heartbeat: true }))
      client.on('error', error => failures.push(error.message))
      client.on('message', (data, binary) => {
        try {
          if (binary) {
            const evidence = pcmEvidence(Buffer.from(data))
            record.bytes += evidence.bytes; record.frames++; record.nonSilent = true
            client.send(JSON.stringify({ type: 'partial', text: syntheticTranscript }))
          } else {
            const message = JSON.parse(data.toString())
            assert.ok(['ping', 'commit', 'end'].includes(message.type))
            if (message.type === 'ping') client.send(JSON.stringify({ type: 'pong' }))
            else {
              record.commits++
              client.send(JSON.stringify({ type: 'final', text: record.bytes ? syntheticTranscript : '', ...(message.commitId ? { commitId: message.commitId } : {}) }))
            }
          }
        } catch (error) { failures.push(error.message); client.close(1008, 'invalid synthetic audio') }
      })
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    port: server.address().port, requests, streams, failures,
    setAvailable(value) { assert.equal(typeof value, 'boolean'); available = value },
    failNextTranscription() { assert.equal(failNext, false); failNext = true },
    async close() {
      for (const client of wss.clients) client.terminate()
      await new Promise(resolve => wss.close(resolve))
      await Promise.allSettled([...active])
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
