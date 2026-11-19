import assert from 'node:assert/strict';
import test from 'node:test';
import { creationMessage } from './creation.js';

test('only recorded creation rejection is presented as a known creation failure', () => {
  for (const outcome of [undefined, 'unknown', 'created'])
    assert.equal(creationMessage(outcome,'PAYMENT_APPLICATION_NOT_ONLINE'),null);
  assert.match(creationMessage('not_created','PAYMENT_APPLICATION_NOT_ONLINE')!,/支付宝应用尚未上线/);
  assert.match(creationMessage('not_created','PAYMENT_DNS_LOOKUP_FAILED')!,/尚未发起支付请求/);
  assert(!creationMessage('not_created','sensitive-fixture')!.includes('sensitive-fixture'));
});
