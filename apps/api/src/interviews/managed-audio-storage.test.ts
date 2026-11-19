import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import type { ObjectStorage } from '@smartrecruit-pro/object-storage'
import { managedInterviewAudioStorage } from './managed-audio-storage.js'
import { runWithTenantContext } from '../db/tenant-context.js'

const key='interviews/11111111-1111-4111-8111-111111111111/chunk.webm'
const tenant = { organizationId: '22222222-2222-4222-8222-222222222222', schemaName: 'company_22222222222242228222222222222222' }
function fixture({ parent = true, commitFails = false, putFails = false } = {}) {
  const calls:string[]=[]
  let commits=0, physical:string|undefined
  const query=async(sql:string,values:unknown[]=[])=>{
    calls.push(sql)
    if(sql==='COMMIT' && ++commits===2 && commitFails) throw Error('commit response lost')
    if(sql.startsWith('INSERT INTO public.interview_stored_objects')) physical=String(values[4])
    return {rows:sql.startsWith('SELECT i.') && parent ? [{organization_id:tenant.organizationId,schema_name:tenant.schemaName}]
      : sql.startsWith('UPDATE public.object_write_intents SET status=\'bound\'') ? [{attempt_id:'attempt'}]
      : sql.startsWith('SELECT o.physical_key') && physical ? [{physical_key:physical,location_id:'a'.repeat(64)}] : []}
  }
  const pool={query,connect:async()=>({query,release(){calls.push('release')}})} as unknown as Pool
  const raw: ObjectStorage={kind:'local',locationId:'a'.repeat(64),put:async physicalKey=>{
    assert.equal(calls.at(-1),'release')
    assert.match(physicalKey,/\/versions\/[a-f0-9-]{36}$/)
    calls.push('put')
    if(putFails) throw Error('put response lost')
  },delete:async()=>{calls.push('delete')},get:async value=>Buffer.from(value),health:async()=>true,
    openRead:async value=>({body:Readable.from([Buffer.from(value)]),byteLength:value.length}),
    putStream:async(physicalKey,body)=>{
      assert.equal(calls.at(-1),'release')
      assert.match(physicalKey,/\/versions\/[a-f0-9-]{36}$/)
      calls.push('stream-put')
      for await (const _part of body) {}
      if(putFails)throw Error('put response lost')
    },
  }
  return {storage:managedInterviewAudioStorage(pool,raw),calls,physical:()=>physical}
}
test('已删除面试不能写入文件',async()=>runWithTenantContext(tenant,async()=>{
  const f=fixture({parent:false})
  await assert.rejects(f.storage.put(key,Buffer.alloc(1),'audio/webm'),{status:404})
  assert.equal(f.calls.includes('put'),false)
}))

test('流写入在预登记后执行并校验摘要，错误摘要不绑定且保留待核对',async()=>runWithTenantContext(tenant,async()=>{
  const audio=Buffer.from('synthetic'),sha256=createHash('sha256').update(audio).digest('hex')
  const f=fixture()
  await f.storage.putStream!(key,Readable.from([audio]),audio.length,'audio/mp4',{sha256})
  assert.ok(f.calls.findIndex(sql=>sql.startsWith('INSERT INTO public.object_write_intents')) < f.calls.indexOf('stream-put'))
  const read=await f.storage.openRead!(key)
  const parts=[];for await(const part of read.body)parts.push(part)
  assert.equal(Buffer.concat(parts).toString(),f.physical())
  const bad=fixture()
  await assert.rejects(bad.storage.putStream!(key,Readable.from([audio]),audio.length,'audio/mp4',{sha256:'b'.repeat(64)}),/HASH_MISMATCH/)
  assert.equal(bad.physical(),undefined)
  assert.ok(bad.calls.some(sql=>sql.includes("status='unknown'")))
  assert.equal(bad.calls.includes('delete'),false)
}))
test('预登记提交后才写物理文件，逻辑键保持稳定并支持幂等读取',async()=>runWithTenantContext(tenant,async()=>{
  const f=fixture()
  await f.storage.put(key,Buffer.alloc(1),'audio/webm')
  assert.ok(f.calls.findIndex(sql=>sql.startsWith('INSERT INTO public.object_write_intents')) < f.calls.indexOf('put'))
  await f.storage.put(key,Buffer.alloc(1),'audio/webm')
  assert.equal(f.calls.filter(sql=>sql==='put').length,1)
  assert.equal((await f.storage.get(key)).toString(),f.physical())
}))
test('提交应答丢失时只条件登记未绑定版本，物理写入不明时保留待核对',async()=>runWithTenantContext(tenant,async()=>{
  const lost=fixture({commitFails:true})
  await assert.rejects(lost.storage.put(key,Buffer.alloc(1),'audio/webm'),/commit response lost/)
  assert.equal(lost.calls.includes('delete'),false)
  assert.ok(lost.calls.some(sql=>sql.includes('object_cleanup_tasks') && sql.includes("status IN ('writing','unknown')")))
  const uncertain=fixture({putFails:true})
  await assert.rejects(uncertain.storage.put(key,Buffer.alloc(1),'audio/webm'),/put response lost/)
  assert.ok(uncertain.calls.some(sql=>sql.includes("status='unknown'")))
  assert.equal(uncertain.calls.some(sql=>sql.includes('object_cleanup_tasks')),false)
}))

test('没有公司上下文不能绑定其他公司的面试文件',async()=>{
  const f=fixture()
  await assert.rejects(f.storage.put(key,Buffer.alloc(1),'audio/webm'),/INVALID_OBJECT_TENANT/)
  assert.equal(f.calls.includes('put'),false)
})
