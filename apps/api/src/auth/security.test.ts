import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAuthCookie, buildCsrfCookie, isAllowedOrigin, isAllowedResumeUploadOrigin, generateCsrfToken, readCookie, parseAllowedOrigins, shouldProtectCsrf } from './security.js'

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

test('development origins accept rotating loopback ports and Cloudflare quick tunnels only', () => {
  const allowlist = ['http://127.0.0.1:5174']
  for (const origin of [
    'http://127.0.0.1:61942',
    'http://localhost:61942',
    'http://[::1]:61942',
    'https://new-random-address.trycloudflare.com',
  ]) assert.equal(isAllowedOrigin(origin, allowlist, true), true, origin)

  for (const origin of [
    'https://trycloudflare.com',
    'https://example.trycloudflare.com.evil.test',
    'https://a.b.trycloudflare.com',
    'http://new-random-address.trycloudflare.com',
    'https://user@new-random-address.trycloudflare.com',
    'http://192.168.1.20:5174',
    'https://evil.example.com',
  ]) assert.equal(isAllowedOrigin(origin, allowlist, true), false, origin)

  assert.equal(isAllowedOrigin('https://new-random-address.trycloudflare.com', allowlist, false), false)
})

test('resume upload origin relaxation is scoped to the three POST onboarding endpoints', () => {
  const allowlist = ['https://app.example.com']
  const temporaryOrigin = 'https://temporary-tunnel.example'
  for (const path of ['/api/v1/candidates', '/api/v1/applications', '/api/v1/resumes']) {
    assert.equal(isAllowedResumeUploadOrigin(temporaryOrigin, allowlist, path, 'POST', 'true'), true, path)
  }
  assert.equal(isAllowedResumeUploadOrigin('https://app.example.com', allowlist, '/api/v1/jobs', 'POST', 'false'), true)
  assert.equal(isAllowedResumeUploadOrigin(temporaryOrigin, allowlist, '/api/v1/jobs', 'POST', 'true'), false)
  assert.equal(isAllowedResumeUploadOrigin(temporaryOrigin, allowlist, '/api/v1/resumes', 'PATCH', 'true'), false)
  assert.equal(isAllowedResumeUploadOrigin(temporaryOrigin, allowlist, '/api/v1/resumes', 'POST', 'false'), false)
  for (const flag of [undefined, '', 'TRUE', '1']) {
    assert.equal(isAllowedResumeUploadOrigin(temporaryOrigin, allowlist, '/api/v1/resumes', 'POST', flag), false)
  }
  for (const path of ['/api/v1/candidates/id', '/api/v1/applications/id', '/api/v1/resumes/', '/api/v1/resumes/id/reparse', '/api/v1/admin/settings', '/api/v1/platform/customers', '/api/v1/auth/switch-workspace']) {
    assert.equal(isAllowedResumeUploadOrigin(temporaryOrigin, allowlist, path, 'POST', 'true'), false, path)
  }
  for (const method of [undefined, 'GET', 'PUT', 'DELETE']) {
    assert.equal(isAllowedResumeUploadOrigin(temporaryOrigin, allowlist, '/api/v1/candidates', method, 'true'), false)
  }
})

test('development origin patterns do not bypass CSRF tokens or endpoint restrictions', () => {
  const origin = 'https://new-random-address.trycloudflare.com'
  assert.equal(isAllowedResumeUploadOrigin(origin, ['https://trusted.example.test'], '/api/v1/jobs', 'POST', undefined, true), true)
  assert.equal(isAllowedResumeUploadOrigin(origin, ['https://trusted.example.test'], '/api/v1/jobs', 'POST', undefined, false), false)
})

test('resume upload origin relaxation accepts only exact HTTP(S) origins', () => {
  const valid = (origin: string) => isAllowedResumeUploadOrigin(origin, [], '/api/v1/resumes', 'POST', 'true')
  assert.equal(valid('http://127.0.0.1:5175'), true)
  assert.equal(valid('https://resume.example.test'), true)
  assert.equal(valid('http://192.168.1.20:5175'), true)
  assert.equal(isAllowedResumeUploadOrigin(undefined, [], '/api/v1/resumes', 'POST', 'true'), false)
  for (const origin of ['', 'null', 'not-a-url', '*', 'https://example.test https://other.test', 'file:///C:/resume.html', 'ftp://example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test/', 'https://example.test?x=1', 'https://example.test#hash']) {
    assert.equal(valid(origin), false, origin || '<missing>')
  }
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
