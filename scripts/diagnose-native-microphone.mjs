import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syntheticMicrophoneWav } from './local-asr-boundary.mjs'

const require = createRequire(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'))
const { chromium } = require('playwright')
const root = resolve(await mkdtemp(join(tmpdir(), 'sr-mic-')))
assert.ok(root.startsWith(resolve(tmpdir()) + '\\'))
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<!doctype html><title>Native microphone diagnostic</title>')
})
const evidence = []
let browser
try {
  const ascii = join(root, 'microphone.wav')
  await writeFile(ascii, syntheticMicrophoneWav())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const variants = [{ file: ascii }, { file: ascii, channel: 'chrome' }, { file: null }, ...process.argv.slice(2).map(file => ({ file, channel: 'chrome' }))]
  for (const { file, channel } of variants) {
    console.log('检查原生采集：' + JSON.stringify({ file, channel }))
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}), args: ['--use-fake-device-for-media-stream', ...(file ? ['--use-file-for-fake-audio-capture=' + file] : [])] })
    const context = await browser.newContext({ permissions: ['microphone'] })
    const page = await context.newPage()
    await page.goto('http://127.0.0.1:' + server.address().port)
    const result = await page.evaluate(async () => {
      const rows = []
      for (const audio of [true, { echoCancellation: true, noiseSuppression: true, autoGainControl: true }]) {
        let stream, context
        try {
          stream = await Promise.race([navigator.mediaDevices.getUserMedia({ audio }), new Promise((_, reject) => setTimeout(() => reject(new Error('原生采集等待超过5秒')), 5000))])
          context = new AudioContext(); await context.resume()
          const source = context.createMediaStreamSource(stream), analyser = context.createAnalyser()
          source.connect(analyser)
          await new Promise(resolve => setTimeout(resolve, 300))
          const samples = new Float32Array(2048); analyser.getFloatTimeDomainData(samples)
          const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length)
          const recorder = new MediaRecorder(stream), chunks = []
          recorder.ondataavailable = event => chunks.push(event.data)
          recorder.start(); await new Promise(resolve => setTimeout(resolve, 300))
          const stopped = new Promise(resolve => recorder.onstop = resolve); recorder.stop(); await stopped
          rows.push({ audio, settings: stream.getAudioTracks()[0].getSettings(), rms, recordedBytes: new Blob(chunks).size })
        } catch (error) { rows.push({ audio, error: { name: error.name, message: error.message } }) }
        finally { stream?.getTracks().forEach(track => track.stop()); await context?.close() }
      }
      return rows
    })
    evidence.push({ file, channel, version: browser.version(), result }); console.log(JSON.stringify(evidence.at(-1), null, 2))
    await browser.close(); browser = undefined
  }
} finally {
  await browser?.close()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
  const output = join(dirname(fileURLToPath(import.meta.url)), '../tmp/native-microphone-diagnostic-' + Date.now() + '.json')
  await writeFile(output, JSON.stringify({ evidence, temporaryDirectoryRemoved: true }, null, 2))
  console.log('诊断证据：' + output)
}
assert.ok(evidence.some(row => row.file && row.result.every(result => !result.error && result.rms > 0.001 && result.recordedBytes > 100)), '所有原生文件采集均未通过，保留错误，不伪造浏览器音频接口')
