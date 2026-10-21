import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlan } from './entitlements.js'
const input={code:'team',version:2,name:'团队新版',seatLimit:10,jobLimit:100,reason:'容量调整'}
test('plans require finite integer capacities and immutable version identity',()=>{
  assert.deepEqual(validatePlan(input),input)
  for(const patch of [{code:'legacy'},{code:'bad code'},{version:0},{version:1.2},{seatLimit:null},{seatLimit:0},{jobLimit:Infinity},{jobLimit:'100'},{name:'a'},{reason:' '},{price:1}]) assert.throws(()=>validatePlan({...input,...patch}),{code:'VALIDATION_ERROR'})
})
