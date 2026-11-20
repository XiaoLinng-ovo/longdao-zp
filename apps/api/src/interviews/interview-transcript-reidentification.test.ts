import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InterviewTranscriptReidentifier } from './interview-transcript-reidentification.js'
import type { InterviewAudioManifestEntry } from './audio-recording-repository.js'

const manifest=[{audioSource:'microphone',sourceRole:'candidate',sourceMultipleSpeakers:false}] as InterviewAudioManifestEntry[]
const full={load:async()=>Buffer.alloc(1)}
const transcribe=async()=>[{id:'one',speakerId:'one',text:'我负责后端开发',startMs:0,endMs:1000}]
test('关闭离线重识别会取消读取并关闭自有整场音频服务', async () => {
  let entered!: () => void, closed = 0, calls = 0
  const loading = new Promise<void>(resolve => { entered = resolve })
  const service = new InterviewTranscriptReidentifier({ ...full,
    loadStream: async (_session, _manifest, _source, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); entered()
    }), close: async () => { closed++ },
  }, async () => { calls++; return [] }, transcribe)
  const work = service.reidentify('session', manifest)
  const rejected = assert.rejects(work)
  await loading
  await Promise.all([service.close(), service.close()]); await rejected
  assert.equal(closed, 1); assert.equal(calls, 0)
  await assert.rejects(service.reidentify('session', manifest), /关闭/)
})
test('lazy decoder failures retain earlier evidence and an explicit completeness warning',async()=>{
  const service=new InterviewTranscriptReidentifier(full,async function*(){yield Buffer.alloc(1);throw Error('decoder stopped')},transcribe)
  const result=await service.reidentify('session',manifest)
  assert.equal(result.segments.length,1)
  assert.ok(result.warnings.some(message=>message.includes('解码中断') && message.includes('decoder stopped')))
})
test('optional secondary recognition may degrade but billing errors must propagate',async()=>{
  for(const code of ['NETWORK_ERROR','BILLING_QUOTA_EXCEEDED','BILLING_RESULT_UNKNOWN']) {
    const service=new InterviewTranscriptReidentifier(full,async function*(){yield Buffer.alloc(1)},transcribe,async()=>{throw Object.assign(Error('failed'),{code})})
    if(code.startsWith('BILLING_')) await assert.rejects(service.reidentify('session',manifest),{code})
    else {
      const result=await service.reidentify('session',manifest)
      assert.equal(result.segments.length,1);assert.ok(result.warnings.some(message=>message.includes('备用识别失败')))
    }
  }
})
