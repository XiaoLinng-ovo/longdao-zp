import {test} from 'node:test'
import assert from 'node:assert/strict'
import {MockPaymentAdapter,type SimulationPaymentEvent} from './mock-payment.js'
test('mock notification adapter rejects malformed payload and foreign secret',()=>{
 const adapter=new MockPaymentAdapter(),event:SimulationPaymentEvent={eventId:'a',orderId:'b',organizationId:'c',channel:'mock_alipay',kind:'success',transactionId:'d',amountFen:100,currency:'CNY',merchant:'sandbox',reason:''}
 const signed=adapter.sign(event);assert.deepEqual(adapter.verify(signed.body,signed.signature),event)
 assert.throws(()=>new MockPaymentAdapter().verify(signed.body,signed.signature),{code:'MOCK_SIGNATURE_INVALID'})
 assert.throws(()=>adapter.verify(signed.body,'bad'),{code:'MOCK_SIGNATURE_INVALID'})
 for(const changed of [{...event,amountFen:NaN},{...event,kind:'live'},null]){const invalid=adapter.sign(changed as any);assert.throws(()=>adapter.verify(invalid.body,invalid.signature),{code:'MOCK_EVENT_INVALID'})}
})
