import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { test } from 'node:test'
import { isAllowedRequestOrigin, requestOrigin } from './request-origin.js'

const production = { NODE_ENV: 'production', REQUIRE_CSRF: 'true' }
function request(headers: Record<string, string | string[] | undefined>, remoteAddress = '203.0.113.8', encrypted = false): IncomingMessage {
  return { headers, socket: { remoteAddress, encrypted } } as unknown as IncomingMessage
}

test('production same-origin requests need no domain registration, even with a stale allowlist', () => {
  for (const origin of ['https://recruit.example.test', 'https://new-address.trycloudflare.com', 'https://recruit.example.test:8443']) {
    const req = request({ origin, host: new URL(origin).host }, '203.0.113.8', true)
    assert.equal(isAllowedRequestOrigin(req, production), true)
    assert.equal(isAllowedRequestOrigin(req, { ...production, ALLOWED_ORIGINS: 'https://old.example.test' }), true)
  }
  assert.equal(isAllowedRequestOrigin(request({ origin: 'http://127.0.0.1:5174', host: '127.0.0.1:5174' }), production), true)
})

test('scheme, host and port must all match, regardless of fetch metadata', () => {
  for (const origin of ['https://attacker.test', 'http://recruit.example.test', 'https://recruit.example.test:8443',
    'https://recruit.example.test.attacker.test', 'null', 'https://recruit.example.test/', undefined]) {
    const req = request({ origin, host: 'recruit.example.test', 'sec-fetch-site': 'same-origin' }, '203.0.113.8', true)
    assert.equal(isAllowedRequestOrigin(req, production), false, String(origin))
  }
})

test('only a trusted proxy can supply the external HTTPS origin', () => {
  const headers = { origin: 'https://new-address.trycloudflare.com', host: 'api:3100',
    'x-forwarded-host': 'new-address.trycloudflare.com', 'x-forwarded-proto': 'https' }
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isAllowedRequestOrigin(request(headers, peer), production), true)
  }
  assert.equal(isAllowedRequestOrigin(request(headers), production), false)
  assert.equal(isAllowedRequestOrigin(request(headers, '172.20.0.3'), production), false)
  assert.equal(isAllowedRequestOrigin(request(headers, '172.20.0.3'), { ...production, ORIGIN_TRUSTED_PROXY_IPS: '172.20.0.0/24' }), true)
  assert.equal(isAllowedRequestOrigin(request(headers, '172.20.0.3'), { ...production, AUTH_TRUSTED_PROXY_IPS: '172.20.0.0/24' }), true)
  assert.equal(isAllowedRequestOrigin(request(headers, '172.20.0.3'), { ...production, ORIGIN_TRUSTED_PROXY_IPS: '', AUTH_TRUSTED_PROXY_IPS: '172.20.0.0/24' }), false)
})

test('a proxy preserving Host may supply only the HTTPS protocol', () => {
  const req = request({ origin: 'https://recruit.example.test', host: 'recruit.example.test', 'x-forwarded-proto': 'https' }, '127.0.0.1')
  assert.equal(isAllowedRequestOrigin(req, production), true)
})

test('malformed and ambiguous proxy authorities cannot become trusted origins', () => {
  for (const host of ['', 'attacker.test,recruit.example.test', 'user@recruit.example.test', 'recruit.example.test/path',
    'recruit.example.test\\path', 'recruit.example.test?x=1', 'recruit.example.test#hash', 'recruit.example.test:',
    'recruit.example.test ', 'recruit%2eexample.test', ['recruit.example.test']]) {
    assert.equal(requestOrigin(request({ host: 'api:3100', 'x-forwarded-host': host, 'x-forwarded-proto': 'https' }, '127.0.0.1'), production), undefined, String(host))
  }
  for (const protocol of ['', 'https,http', 'https, https', 'ftp', ['https']]) {
    assert.equal(requestOrigin(request({ host: 'recruit.example.test', 'x-forwarded-proto': protocol }, '127.0.0.1'), production), undefined)
  }
})

test('canonical default ports and IPv6 authorities are supported', () => {
  assert.equal(requestOrigin(request({ host: 'RECRUIT.example.test:443' }, '203.0.113.8', true), production), 'https://recruit.example.test')
  assert.equal(requestOrigin(request({ host: '[::1]:5174' }), production), 'http://[::1]:5174')
  assert.equal(isAllowedRequestOrigin(request({ origin: ['https://recruit.example.test'], host: 'recruit.example.test' }, '203.0.113.8', true), production), false)
})

test('explicit cross-origin entries remain exact and wildcard does not grant access', () => {
  const req = request({ origin: 'https://frontend.example.test', host: 'api.example.test' }, '203.0.113.8', true)
  assert.equal(isAllowedRequestOrigin(req, production), false)
  assert.equal(isAllowedRequestOrigin(req, { ...production, ALLOWED_ORIGINS: '*' }), false)
  assert.equal(isAllowedRequestOrigin(req, { ...production, ALLOWED_ORIGINS: 'https://frontend.example.test' }), true)
})
