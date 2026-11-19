import assert from 'node:assert/strict'
import { test } from 'node:test'
import { refundCheckDelaySeconds } from './reconciliation-backoff.js'
test('退款退避有随机抖动、增长和一小时硬上限，不丢弃未知退款',()=>{
  assert.equal(refundCheckDelaySeconds(1,()=>0),48)
  assert.equal(refundCheckDelaySeconds(2,()=>0.5),120)
  assert.equal(refundCheckDelaySeconds(100,()=>1),3600)
})
