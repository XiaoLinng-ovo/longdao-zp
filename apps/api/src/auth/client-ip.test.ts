import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAuthClientIp } from './client-ip.js'

test('ignores forwarded headers from untrusted peers', () => {
  const env = { AUTH_TRUSTED_PROXY_IPS: '10.0.0.0/8' } as NodeJS.ProcessEnv
  assert.equal(
    resolveAuthClientIp('203.0.113.10', '198.51.100.20', env),
    '203.0.113.10',
  )
})

test('uses the rightmost untrusted address from a trusted proxy chain', () => {
  const env = { AUTH_TRUSTED_PROXY_IPS: '10.0.0.2,10.0.0.0/8' } as NodeJS.ProcessEnv
  assert.equal(
    resolveAuthClientIp('10.0.0.2', '198.51.100.30, 10.0.0.5', env),
    '198.51.100.30',
  )
})

test('supports IPv4 and IPv6 trusted CIDR ranges', () => {
  assert.equal(
    resolveAuthClientIp(
      '172.18.0.4',
      '203.0.113.40, 172.18.0.9',
      { AUTH_TRUSTED_PROXY_IPS: '172.16.0.0/12' } as NodeJS.ProcessEnv,
    ),
    '203.0.113.40',
  )
  assert.equal(
    resolveAuthClientIp(
      'fd00::2',
      '2001:db8::4, fd00::3',
      { AUTH_TRUSTED_PROXY_IPS: 'fd00::/8' } as NodeJS.ProcessEnv,
    ),
    '2001:db8::4',
  )
})

test('normalizes IPv4-mapped addresses before trust checks', () => {
  assert.equal(
    resolveAuthClientIp(
      '::ffff:127.0.0.1',
      '::ffff:198.51.100.50',
      { AUTH_TRUSTED_PROXY_IPS: '127.0.0.1' } as NodeJS.ProcessEnv,
    ),
    '198.51.100.50',
  )
})

test('falls back to the peer address for malformed or excessive proxy chains', () => {
  const env = { AUTH_TRUSTED_PROXY_IPS: '127.0.0.1' } as NodeJS.ProcessEnv
  assert.equal(resolveAuthClientIp('127.0.0.1', 'not-an-ip', env), '127.0.0.1')
  assert.equal(resolveAuthClientIp('127.0.0.1', '', env), '127.0.0.1')
  assert.equal(
    resolveAuthClientIp(
      '127.0.0.1',
      Array.from({ length: 21 }, (_, index) => `198.51.100.${index + 1}`).join(','),
      env,
    ),
    '127.0.0.1',
  )
})
