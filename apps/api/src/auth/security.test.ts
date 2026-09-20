import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAuthCookie, buildCsrfCookie, isAllowedOrigin, generateCsrfToken, readCookie, parseAllowedOrigins, shouldProtectCsrf } from './security.js'

test('auth cookie is hardened in production', () => {
  const cookie = buildAuthCookie('abc', { production: true })
  assert.match(cookie, /^__Host-smartrecruit_session=abc;/)
  assert.match(cookie, /Secure/)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Path=\//)
})

test('csrf cookie is readable by browser and token is random', () => {
  const token = generateCsrfToken()
  assert.equal(token.length > 20, true)
  assert.match(buildCsrfCookie(token, { production: true }), /^__Host-smartrecruit_csrf=/)
  assert.doesNotMatch(buildCsrfCookie(token, { production: true }), /HttpOnly/)
})

test('origin allowlist accepts configured origin only', () => {
  assert.equal(isAllowedOrigin('https://app.example.com', ['https://app.example.com']), true)
  assert.equal(isAllowedOrigin('https://evil.example.com', ['https://app.example.com']), false)
  assert.equal(isAllowedOrigin(undefined, ['https://app.example.com']), false)
})

test('parses comma separated origin allowlist and removes whitespace and blanks', () => {
  assert.deepEqual(parseAllowedOrigins(' https://app.example.com, ,https://admin.example.com '), [
    'https://app.example.com',
    'https://admin.example.com'
  ])
  assert.deepEqual(parseAllowedOrigins(undefined), [])
})

test('csrf protection is enabled for write methods by default', () => {
  assert.equal(shouldProtectCsrf('POST', 'true'), true)
  assert.equal(shouldProtectCsrf('DELETE', 'true'), true)
  assert.equal(shouldProtectCsrf('GET', 'true'), false)
  assert.equal(shouldProtectCsrf('POST', 'false'), false)
  assert.equal(shouldProtectCsrf('POST', undefined), true)
  assert.equal(shouldProtectCsrf('PATCH', undefined), true)
  assert.equal(shouldProtectCsrf('GET', undefined), false)
})

test('reads prefixed csrf cookie in production', () => {
  const token = generateCsrfToken()
  const cookie = buildCsrfCookie(token, { production: true })
  assert.equal(readCookie(cookie, 'smartrecruit_csrf', { production: true }), token)
})
