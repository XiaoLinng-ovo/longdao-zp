import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FullInterviewAudio } from './full-audio.js'
import type { InterviewAudioManifestEntry } from './audio-recording-repository.js'

const execute = promisify(execFile), ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const session = randomUUID()
function wav(ms: number, hz: number): Buffer {
  const samples = Math.round(ms * 16), buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28)
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * hz * i / 16000)), 44 + i * 2)
  return buffer
}
function store() {
  const files = new Map<string, Buffer>(), reads: string[] = [], writes: string[] = []
  return { files, reads, writes,
    async read(key: string) { reads.push(key); const file = files.get(key); if (!file) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return file },
    async write(key: string, data: Uint8Array) { writes.push(key); files.set(key, Buffer.from(data)) },
  }
}
function row(key: string, offsetMs: number, audioSource?: 'microphone' | 'meeting'): InterviewAudioManifestEntry {
  return { id: randomUUID(), sessionId: session, sessionStartedAt: new Date().toISOString(), createdAt: new Date().toISOString(), objectKey: key, offsetMs, endMs: offsetMs + 10, byteLength: null, contentType: 'audio/wav', ...(audioSource ? { audioSource } : {}) }
}
async function decode(buffer: Buffer): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'full-audio-test-'))
  try {
    const path = join(directory, 'audio.m4a'); await writeFile(path, buffer)
    return (await execute(ffmpeg, ['-v','error','-i',path,'-f','s16le','-ac','1','-ar','16000','pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024, windowsHide: true })).stdout
  } finally { await rm(directory, { recursive: true, force: true }) }
}
function amplitude(pcm: Buffer, ms: number, hz: number) {
  let sin = 0, cos = 0
  for (let i = 0; i < 800; i++) { const value = pcm.readInt16LE((ms * 16 + i) * 2); sin += value * Math.sin(2 * Math.PI * hz * i / 16000); cos += value * Math.cos(2 * Math.PI * hz * i / 16000) }
  return Math.hypot(sin, cos) / 400
}
test('whole audio preserves capture offsets, gaps, overlap, trailing speech and separate source exports', async () => {
  const storage = store(), service = new FullInterviewAudio(storage), manifest = [row('mic1',0,'microphone'),row('meeting',100,'meeting'),row('mic2',700,'microphone')]
  storage.files.set('mic1', wav(200,440)); storage.files.set('meeting', wav(400,880)); storage.files.set('mic2', wav(200,440))
  const full = await decode(await service.load(session, manifest, 'all'))
  assert.ok(full.length / 32 >= 900, 'must not trim audio at transcript endMs')
  assert.ok(amplitude(full,130,440) > 2000); assert.ok(amplitude(full,130,880) > 2000, 'overlapping sources survive')
  assert.ok(amplitude(full,550,440) < 100, 'capture gap stays silent')
  assert.ok(amplitude(full,800,440) > 2000, 'later chunk stays at its clock offset')
  const mic = await decode(await service.load(session, manifest, 'microphone'))
  assert.ok(amplitude(mic,130,440) > 5000); assert.ok(amplitude(mic,130,880) < 100)
  assert.ok(amplitude(mic,300,880) < 100, 'remote audio is excluded from microphone export')
  const remote = await decode(await service.load(session, manifest, 'meeting'))
  assert.ok(amplitude(remote,10,880) < 100); assert.ok(amplitude(remote,300,880) > 5000)
})
test('concurrent downloads share generation and manifest changes invalidate the persisted cache', async () => {
  const storage = store(), service = new FullInterviewAudio(storage), manifest = [row('one',0)]
  storage.files.set('one', wav(100,440))
  const [a,b] = await Promise.all([service.load(session,manifest,'all'),service.load(session,manifest,'all')])
  assert.deepEqual(a,b); assert.equal(storage.writes.length,1); assert.equal(storage.reads.filter(key => key === 'one').length,1)
  await new FullInterviewAudio(storage).load(session,manifest,'all'); assert.equal(storage.writes.length,1)
  storage.files.set('two',wav(100,880)); await service.load(session,[...manifest,row('two',200)],'all'); assert.equal(storage.writes.length,2)
})
test('missing/corrupt originals fail visibly without caching a misleading partial recording', async () => {
  const storage = store(), service = new FullInterviewAudio(storage)
  storage.files.set('good',wav(100,440))
  await assert.rejects(service.load(session,[row('good',0),row('missing',100)],'all'), /部分原音频文件不存在/)
  storage.files.set('corrupt',Buffer.from('invalid container'))
  await assert.rejects(service.load(session,[row('corrupt',0)],'all'), /无法解码/)
  assert.equal(storage.writes.length,0)
})
test('unknown sources remain legacy, foreign sessions cannot leak, invalid offsets and missing processor have clear errors', async () => {
  const storage = store(), service = new FullInterviewAudio(storage), legacy = row('legacy',0)
  storage.files.set('legacy',wav(100,440))
  await assert.rejects(service.load(session,[legacy],'meeting'), /没有此音源/)
  await assert.rejects(service.load(randomUUID(),[legacy],'all'), /没有此音源/)
  await assert.rejects(service.load(session,[{...legacy,offsetMs:-1}],'all'), /超出/)
  await service.load(session,[legacy],'legacy'); assert.equal(storage.writes.length,1)
  const missingProcessor = new FullInterviewAudio(storage, join(tmpdir(), 'nonexistent-' + randomUUID()))
  await assert.rejects(missingProcessor.load(session,[legacy],'all'), /FFMPEG_PATH/)
})
