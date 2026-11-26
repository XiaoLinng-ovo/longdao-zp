import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeInterviewParticipants } from './interview-responsibilities.js'
const members = () => [
  {userId:'a',role:'interviewer',lead:true,sheetTypes:['hr_screen']},
  {userId:'b',role:'interviewer',lead:false,sheetTypes:['hiring_department']},
]
describe('interview responsibilities', () => {
  it('preserves multi interviewer assignments and a single lead', () => {
    const result = normalizeInterviewParticipants(members(),'initial')
    assert.equal(result.length,2); assert.equal(result[0]!.lead,true)
    assert.deepEqual(result[1]!.sheetTypes,['hiring_department'])
  })
  it('rejects duplicate people, duplicate sheet owners, missing or multiple leads and wrong-stage assignments', () => {
    assert.throws(() => normalizeInterviewParticipants([...members(),members()[0]],'initial'))
    assert.throws(() => normalizeInterviewParticipants(members().map(person => ({...person,sheetTypes:['hr_screen']})),'initial'))
    assert.throws(() => normalizeInterviewParticipants(members().map(person => ({...person,lead:false})),'initial'))
    assert.throws(() => normalizeInterviewParticipants(members().map(person => ({...person,lead:true})),'initial'))
    assert.throws(() => normalizeInterviewParticipants(members(),'final'))
    assert.throws(() => normalizeInterviewParticipants([{...members()[0],sheetTypes:[]}],'initial'))
    assert.throws(() => normalizeInterviewParticipants([{...members()[0],role:'observer'}],'initial'))
  })
  it('keeps legacy records without assigning ownership', () => {
    assert.deepEqual(normalizeInterviewParticipants([],'initial'),[])
    assert.equal(normalizeInterviewParticipants([{userId:'old'}],'initial')[0]!.lead,undefined)
  })
})
