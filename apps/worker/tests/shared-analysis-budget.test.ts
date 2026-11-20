import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PgClient } from '../src/db/analysis-task-store.js'
import { loadSharedAnalysisBudget, reserveSharedAnalysisSlot } from '../src/db/shared-analysis-budget.js'

test('shared limits are explicitly bounded and default conservatively',()=>{
  assert.deepEqual(loadSharedAnalysisBudget({}),{platform:4,workspace:2})
  for(const value of ['0','101','1.2','bad','']) assert.throws(()=>loadSharedAnalysisBudget({WORKER_SHARED_CONCURRENCY:value}))
})
test('all ready companies participate and fairness can choose the second company',async()=>{
  const calls:Array<{sql:string;values:unknown[]}>=[]
  const db={async query(sql:string,values:unknown[]=[]) {
    calls.push({sql,values})
    if(sql.startsWith('SELECT DISTINCT')) return {rows:[{organization_id:'first'},{organization_id:'second'}]}
    if(sql.includes('AS allowed')) return {rows:[{allowed:true}]}
    if(sql.includes('ORDER BY s.last_claimed_at')) return {rows:[{organization_id:'second'}]}
    return {rows:[]}
  }} as unknown as PgClient
  assert.equal(await reserveSharedAnalysisSlot(db,{platform:4,workspace:1},new Date().toISOString(),3),'second')
  assert.match(calls[0]!.sql,/pg_advisory_xact_lock/)
  assert.ok(calls.some(call=>call.sql.includes('unnest') && JSON.stringify(call.values[0])==='["first","second"]'))
})
test('full platform budget cannot allocate a slot',async()=>{
  const db={async query(sql:string) {
    if(sql.startsWith('SELECT DISTINCT')) return {rows:[{organization_id:'first'}]}
    return {rows:[]}
  }} as unknown as PgClient
  assert.equal(await reserveSharedAnalysisSlot(db,{platform:1,workspace:1},new Date().toISOString(),3),undefined)
})
