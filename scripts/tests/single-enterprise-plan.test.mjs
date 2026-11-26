import {test} from 'node:test'
import assert from 'node:assert/strict'
import {validateResolutionPlan} from '../resolve-single-enterprise.mjs'
const ids=Array.from({length:5},(_,i)=>String(i+1).repeat(8)+'-1111-4111-8111-111111111111')
const row={organizationId:ids[0],userId:ids[1],actorId:ids[2],replacementId:ids[2],keepOrganizationId:ids[3],reason:'confirmed departure'}
test('resolution requires explicit retained enterprise, receiver, administrator and reason',()=>{
 assert.deepEqual(validateResolutionPlan([row]),[row])
 for(const value of [[],[{}],[{...row,reason:' '}],[{...row,keepOrganizationId:row.organizationId}],[{...row,actorId:row.userId}],[{...row,unknown:true}],[row,row]])assert.throws(()=>validateResolutionPlan(value))
})
