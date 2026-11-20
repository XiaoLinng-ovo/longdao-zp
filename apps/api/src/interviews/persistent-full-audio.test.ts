import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { PersistentFullAudioTranscription, startPersistentFullAudioPoll, loadFullAudioBudget } from './persistent-full-audio.js'

test('full audio concurrency has conservative defaults and refuses unsafe values',()=>{
  assert.deepEqual(loadFullAudioBudget({}),{platform:2,workspace:1})
  assert.deepEqual(loadFullAudioBudget({FULL_AUDIO_SHARED_CONCURRENCY:'4',FULL_AUDIO_WORKSPACE_CONCURRENCY:'2'}),{platform:4,workspace:2})
  for(const value of ['0','17','NaN','1.5']) assert.throws(()=>loadFullAudioBudget({FULL_AUDIO_SHARED_CONCURRENCY:value}))
})

function fixture(fail=false, inspectEnvironment?: (env: NodeJS.ProcessEnv) => void) {
  const calls:Array<{sql:string;values:unknown[]}>=[],events:string[]=[]
  const task={id:'task',organization_id:'org',interview_id:'interview',session_id:'session',schema_name:'public',storage_key:'key',source:'all' as const,fingerprint:'version',status:'processing',progress:0,text:'',next_chunk:0,lease_token:'token',updated_at:new Date(),last_error:null}
  const query=async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values})
    if(sql.startsWith('UPDATE') && sql.includes('last_claimed_at=now()')) return {rows:[task]}
    if(sql.startsWith('SELECT public.organization_service_available')) return {rows:[{available:true}]}
    if(sql.includes('RETURNING id')) return {rows:[{id:'task'}]}
    return {rows:[]}
  }
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool
  const service=new PersistentFullAudioTranscription(pool,async()=>({load:async()=>Buffer.alloc(1),totalChunks:2,env:{OPENAI_MODEL:'billing-only'},meter:async(_audio,_index,action)=>action()}),async(_audio,_type,env=process.env)=>{
    inspectEnvironment?.(env)
    events.push('recognize');if(fail) throw Error('connection lost');return []
  },async function*(){events.push('chunk1');yield Buffer.alloc(1);events.push('chunk2');yield Buffer.alloc(1)})
  return {service,calls,events}
}
test('persistent full transcription consumes and checkpoints one chunk at a time',async()=>{
  const old=process.env.TENANT_SCHEMA_ROUTING;process.env.TENANT_SCHEMA_ROUTING='off'
  try {
    const f=fixture();assert.equal(await f.service.processPending(),true)
    assert.deepEqual(f.events,['chunk1','recognize','chunk2','recognize'])
    assert.equal(f.calls.filter(call=>call.sql.includes('next_chunk=$4')).length,2)
    assert.ok(f.calls.some(call=>call.sql.includes("status='completed'")))
  } finally {if(old===undefined) delete process.env.TENANT_SCHEMA_ROUTING;else process.env.TENANT_SCHEMA_ROUTING=old}
})
test('uncertain inference is marked unknown rather than queued for duplicate paid calls',async()=>{
  const old=process.env.TENANT_SCHEMA_ROUTING;process.env.TENANT_SCHEMA_ROUTING='off'
  try {
    const f=fixture(true);await f.service.processPending()
    const failure=f.calls.find(call=>call.sql.includes('status=$3,last_error=$4'))!
    assert.equal(failure.values[2],'unknown');assert.equal(failure.values[4],true)
    assert.deepEqual(f.events,['chunk1','recognize'])
  } finally {if(old===undefined) delete process.env.TENANT_SCHEMA_ROUTING;else process.env.TENANT_SCHEMA_ROUTING=old}
})
test('full audio uses platform speech configuration, not the enterprise model billing environment', async () => {
  const old = process.env.TENANT_SCHEMA_ROUTING
  process.env.TENANT_SCHEMA_ROUTING = 'off'
  let inspected = 0
  try {
    const f = fixture(false, env => { assert.equal(env, process.env); inspected++ })
    assert.equal(await f.service.processPending(), true)
    assert.equal(inspected, 2)
    assert.ok(f.calls.some(call => call.sql.includes("status='completed'")))
  } finally {
    if (old === undefined) delete process.env.TENANT_SCHEMA_ROUTING
    else process.env.TENANT_SCHEMA_ROUTING = old
  }
})
test('closing full audio polling drains the current task',async()=>{
  let finish!:()=>void,ended=false
  const pending=new Promise<void>(resolve=>{finish=resolve})
  const stop=startPersistentFullAudioPoll({async processPending(){await pending;ended=true;return true}})
  const draining=Promise.resolve(stop())
  assert.equal(ended,false);finish();await draining;assert.equal(ended,true)
})

test('closing persistent transcription cancels loading, drains work and closes only owned resources once', async () => {
  const old = process.env.TENANT_SCHEMA_ROUTING
  process.env.TENANT_SCHEMA_ROUTING = 'off'
  let loaded!: () => void
  const started = new Promise<void>(resolve => { loaded = resolve })
  const task = { id: 'task', organization_id: 'org', schema_name: 'public', storage_key: 'key',
    source: 'all', fingerprint: 'version', status: 'processing', progress: 0, text: '', next_chunk: 0,
    lease_token: 'token', updated_at: new Date(), last_error: null }
  let queries = 0, resourceCloses = 0, poolCloses = 0, splits = 0, inferences = 0
  const query = async (sql: string) => {
    queries++
    if (sql.includes('last_claimed_at=now()')) return { rows: [task] }
    if (sql.startsWith('SELECT public.organization_service_available')) return { rows: [{ available: true }] }
    if (sql.includes('RETURNING id')) return { rows: [{ id: 'task' }] }
    return { rows: [] }
  }
  const pool = { query, connect: async () => ({ query, release() {} }), end: async () => { poolCloses++ } } as unknown as Pool
  const service = new PersistentFullAudioTranscription(pool, async () => ({
    load: async signal => {
      loaded()
      return new Promise<Buffer>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
    }, totalChunks: 1, meter: async (_audio, _index, action) => action(),
  }), async () => { inferences++; return [] }, async function* () { splits++; yield Buffer.alloc(1) },
  { platform: 2, workspace: 1 }, async () => { resourceCloses++ })
  try {
    const work = service.processPending()
    await started
    const closing = service.close()
    assert.equal(service.close(), closing)
    await closing
    assert.equal(await work, true)
    const after = queries
    assert.equal(await service.processPending(), false)
    assert.equal(queries, after)
    assert.equal(resourceCloses, 1)
    assert.equal(poolCloses, 0)
    assert.equal(splits, 0)
    assert.equal(inferences, 0)
  } finally {
    await service.close()
    if (old === undefined) delete process.env.TENANT_SCHEMA_ROUTING
    else process.env.TENANT_SCHEMA_ROUTING = old
  }
})
