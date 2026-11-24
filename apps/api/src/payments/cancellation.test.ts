import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError } from '../http.js';
import { cancellationFailure, cancellationMessage } from './cancellation.js';
import { orderView } from './service.js';

test('only known channel errors may defer cancellation; no arbitrary error content is exposed', () => {
  for (const code of ['PAYMENT_APPLICATION_NOT_ONLINE', 'PAYMENT_ENDPOINT_BLOCKED', 'PAYMENT_DNS_LOOKUP_FAILED', 'PAYMENT_UPSTREAM_UNCERTAIN', 'PAYMENT_CLOSE_UNSUPPORTED']) {
    assert.equal(cancellationFailure(new HttpError(502, code, 'secret-fixture')), code);
    assert(!cancellationMessage(code).includes('secret-fixture'));
  }
  for (const error of [new Error('timeout'), new HttpError(403, 'WORKSPACE_MEMBER_REQUIRED', 'no access'), new HttpError(409, 'PAYMENT_EVENT_MISMATCH', 'wrong order'), { code: 'PAYMENT_UPSTREAM_UNCERTAIN' }])
    assert.equal(cancellationFailure(error), null);
  assert(!cancellationMessage('__proto__').includes('secret-fixture'));
});

test('a cancellation request suppresses every payment entry but never falsely changes the financial status', () => {
  const row = { id: 'fixture', status: 'uncertain', cancel_requested_at: new Date(), cancel_error_code: 'PAYMENT_APPLICATION_NOT_ONLINE', pay_url: 'https://pay.example.com', qr_code: 'fixture-qr' };
  const view = orderView(row);
  assert.equal(view.status, 'uncertain');
  assert.equal(view.payURL, null);
  assert.equal(view.qrCode, null);
  assert.match(view.cancellationMessage!, /尚未上线/);
  assert.equal(orderView({ ...row, status: 'cancelled' }).cancellationMessage, null);
  assert.equal(orderView({ ...row, status: 'fulfilled' }).cancellationMessage, null);
});
