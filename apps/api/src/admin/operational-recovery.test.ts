import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { OperationalRecoveryService } from './operational-recovery.js'

const id='11111111-1111-4111-8111-111111111111'
function fixture(auditFails=false, conflict=false) {
  const calls:string[]=[]
  let released=false
  const query=async(sql:string)=>{
    calls.push(sql)
    if (sql.includes('platform_audit_logs') && auditFails) throw Error('audit failed')
    return {rows:sql.startsWith('UPDATE') && !conflict ? [{organization_id:id}] : []}
  }
  const pool={query,connect:async()=>({query,release(){released=true}})} as unknown as Pool
  return {service:new OperationalRecoveryService(pool),calls,released:()=>released}
}
test('recovery changes and administrator audit commit atomically without external calls',async()=>{
  for(const kind of ['cleanup','audio']) {
    const f=fixture()
    await f.service.resolve(kind,id,kind==='cleanup'?'retry':'stop','verified in logs',id,'123')
    assert.equal(f.calls[0],'BEGIN'); assert.equal(f.calls.at(-1),'COMMIT')
    assert.ok(f.calls[2]?.includes('platform_audit_logs')); assert.equal(f.released(),true)
    assert.match(f.calls[1]!,/xmin::text=\$2/)
    if(kind==='audio') assert.match(f.calls[1]!,/inference_pending=true/)
  }
})
test('audit failure and changed task state roll back recovery',async()=>{
  for(const [auditFails,conflict] of [[true,false],[false,true]]) {
    const f=fixture(auditFails,conflict)
    await assert.rejects(f.service.resolve('cleanup',id,'retry','verified in logs',id,'123'))
    assert.equal(f.calls.at(-1),'ROLLBACK'); assert.equal(f.released(),true)
  }
})
test('unknown audio cannot be blindly retried and invalid decisions never acquire a connection',async()=>{
  const f=fixture()
  for(const input of [['audio',id,'retry','verified'],['cleanup','bad','retry','verified'],['cleanup',id,'retry','no']])
    await assert.rejects(f.service.resolve(input[0]!,input[1]!,input[2]!,input[3]!,id,'123'),{status:400})
  assert.equal(f.calls.length,0)
})

test('缺少版本或版本无效时拒绝人工核对，不连接数据库',async()=>{
  const f=fixture()
  for (const version of ['', 'not-a-version', '12345678901']) await assert.rejects(f.service.resolve('audio',id,'stop','verified in logs',id,version),{status:409,code:'RECOVERY_CONFLICT'})
  assert.equal(f.calls.length,0)
})

test('核对列表明确报告现有转写无只读查结果能力',async()=>{
  const f=fixture(), result=await f.service.list()
  assert.equal(result.audioLookup.supported,false)
  assert.match(result.audioLookup.reason,/不会重新提交/)
  assert.ok(f.calls.some(sql=>sql.includes('xmin::text AS recovery_version')))
})
