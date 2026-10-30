import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FullAudioTranscription, type FullAudioTranscriptionJob } from './full-audio-transcription.js'

const segment = (text: string) => ({ id: 'segment', speakerId: 'unknown', text, startMs: 0, endMs: 1000 })

function storage() {
  const files = new Map<string, Buffer>()
  return { files,
    async read(key: string) { const value = files.get(key); if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return value },
    async write(key: string, value: Uint8Array) { files.set(key, Buffer.from(value)) },
  }
}
async function until(done: () => boolean | Promise<boolean>) {
  const end = Date.now() + 1000
  while (!(await done()) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(await done(), 'background transcription should settle')
}
test('transcribes chunks in order, persists progress and reuses completed results', async () => {
  const store = storage(), calls: string[] = []
  const service = new FullAudioTranscription(store, async audio => { calls.push(Buffer.from(audio).toString()); return [segment(Buffer.from(audio).toString())] }, async () => [Buffer.from('第一段'), Buffer.from('第二段')])
  const load = async () => Buffer.from('audio')
  const first = await service.start('job.json', load)
  assert.equal(first.status, 'processing')
  await until(async () => (await service.get('job.json'))?.status === 'completed')
  const result = await service.get('job.json') as FullAudioTranscriptionJob
  assert.equal(result.status, 'completed'); assert.equal(result.progress, 100); assert.equal(result.text, '第一段\n第二段')
  assert.deepEqual(calls, ['第一段', '第二段'])
  assert.deepEqual(await service.start('job.json', async () => { throw new Error('cached job must not reload') }), result)
})

test('stores a retryable failure and a later start reruns the job', async () => {
  const store = storage(); let attempts = 0
  const service = new FullAudioTranscription(store, async () => { if (++attempts === 1) throw new Error('upstream unavailable'); return [segment('恢复成功')] }, async () => [Buffer.from('chunk')])
  await service.start('retry.json', async () => Buffer.from('audio'))
  await until(async () => (await service.get('retry.json'))?.status === 'failed')
  assert.equal((await service.get('retry.json'))?.error, '整段转写失败，请检查转写服务后重试。')
  await service.start('retry.json', async () => Buffer.from('audio'))
  await until(async () => (await service.get('retry.json'))?.status === 'completed')
  assert.equal((await service.get('retry.json'))?.text, '恢复成功')
  assert.equal(attempts, 2)
})

test('deduplicates simultaneous starts for the same job key', async () => {
  const store = storage(); let loads = 0
  const service = new FullAudioTranscription(store, async () => [segment('一次')], async () => [Buffer.from('chunk')])
  const load = async () => { loads++; await new Promise(resolve => setTimeout(resolve, 10)); return Buffer.from('audio') }
  await Promise.all([service.start('same.json', load), service.start('same.json', load)])
  await until(async () => (await service.get('same.json'))?.status === 'completed')
  assert.equal(loads, 1)
})
