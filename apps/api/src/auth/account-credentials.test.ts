import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { AuthService } from './auth-service.js'
import { LocalAuthSessionStore } from './session-store.js'
import { EmailVerificationService } from './verification-service.js'
import { hashVerificationCode } from './verification-code.js'
import type { AuthContext } from './types.js'

const env = { NODE_ENV: 'test', AUTH_OTP_HMAC_SECRET: 'account-change-test-secret-at-least-32-characters', AUTH_MFA_EXEMPT_EMAILS: 'reserved@example.invalid' }

test('password dialog requires delivered current-email OTP and consumes it only on final atomic write', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'password-dialog-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'auth.json'), store = new LocalAuthSessionStore(path)
  let code = '', destination = '', rejectMail = false
  const verificationService = new EmailVerificationService(store, { async send(input) {
    code = input.markdown.match(/\*\*(\d{6})\*\*/u)![1]!
    destination = input.to
    if (rejectMail) throw new Error('private SMTP error')
  } }, env)
  const service = new AuthService(store, { env, verificationService })
  const user = (await store.findUserByEmailPassword('admin@smartrecruit.local', 'admin123'))!
  const login = await store.createSession(user)
  const auth: AuthContext = { user, method: 'session', sessionId: login.session.sessionId }
  const snapshot = async () => JSON.parse(await readFile(path, 'utf8'))
  const alter = async (fn: (file: any) => void) => { const file = await snapshot(); fn(file); await writeFile(path, JSON.stringify(file)) }
  const age = () => alter(file => { file.emailVerificationChallenges.forEach((c: any) => { c.createdAt = new Date(Date.now() - 61_000).toISOString() }) })
  await assert.rejects(service.changePassword(auth, { newPassword: 'new-password-test' }), { code: 'VALIDATION_ERROR' })
  await assert.rejects(service.requestAccountPasswordCode({ ...auth, method: 'development-bootstrap' }), { code: 'AUTHENTICATION_REQUIRED' })
  rejectMail = true
  await assert.rejects(service.requestAccountPasswordCode(auth), { code: 'VERIFICATION_MAIL_UNAVAILABLE' })
  await assert.rejects(service.verifyAccountPasswordCode(auth, { verificationCode: code }), { code: 'INVALID_VERIFICATION_CODE' })
  rejectMail = false
  await age(); await service.requestAccountPasswordCode(auth)
  assert.equal(destination, user.email)
  await assert.rejects(service.requestAccountPasswordCode(auth), { code: 'VERIFICATION_RATE_LIMITED' })
  const wrong = code === '000000' ? '111111' : '000000'
  for (let i = 0; i < 5; i++) await assert.rejects(service.verifyAccountPasswordCode(auth, { verificationCode: wrong }), { code: 'INVALID_VERIFICATION_CODE' })
  await assert.rejects(service.verifyAccountPasswordCode(auth, { verificationCode: code }), { code: 'INVALID_VERIFICATION_CODE' })
  await age(); await service.requestAccountPasswordCode(auth)
  await alter(file => { delete file.emailVerificationChallenges.at(-1).deliveredAt })
  await assert.rejects(service.changePassword(auth, { verificationCode: code, newPassword: 'new-password-test' }), { code: 'INVALID_VERIFICATION_CODE' })
  await age(); await service.requestAccountPasswordCode(auth)
  await service.verifyAccountPasswordCode(auth, { verificationCode: code })
  assert.equal((await snapshot()).emailVerificationChallenges.at(-1).consumedAt, undefined)
  await alter(file => { file.emailVerificationChallenges.at(-1).expiresAt = new Date(Date.now() - 1000).toISOString() })
  await assert.rejects(service.changePassword(auth, { verificationCode: code, newPassword: 'new-password-test' }), { code: 'INVALID_VERIFICATION_CODE' })
  await age(); await service.requestAccountPasswordCode(auth)
  const other = (await store.findUserByEmailPassword('recruiter@smartrecruit.local', 'recruiter123'))!
  const otherLogin = await store.createSession(other)
  await assert.rejects(service.verifyAccountPasswordCode({ user: other, method: 'session', sessionId: otherLogin.session.sessionId }, { verificationCode: code }), { code: 'INVALID_VERIFICATION_CODE' })
  await service.verifyAccountPasswordCode(auth, { verificationCode: code })
  const result = await Promise.allSettled([1, 2].map(() => service.changePassword(auth, { verificationCode: code, newPassword: 'new-password-test' })))
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(await store.findSessionByToken(login.token), undefined)
  assert.equal((await store.findUserByEmailPassword(user.email, 'new-password-test'))?.id, user.id)
  const nextLogin = await store.createSession(user)
  await assert.rejects(service.changePassword({ ...auth, sessionId: nextLogin.session.sessionId }, { verificationCode: code, newPassword: 'another-password-test' }), { code: 'INVALID_VERIFICATION_CODE' })
})

test('account credential changes preserve identity, require delivered account-bound codes and revoke sessions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'account-credentials-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'auth.json')
  const store = new LocalAuthSessionStore(path)
  let code = '', rejectMail = false, holdMail: Promise<void> | undefined
  const verificationService = new EmailVerificationService(store, { async send(input) {
    code = input.markdown.match(/\*\*(\d{6})\*\*/u)![1]!
    if (rejectMail) throw new Error('SMTP secret must never appear in the API error')
    if (holdMail) await holdMail
  } }, env)
  const service = new AuthService(store, { env, verificationService })
  const original = (await store.findUserByEmailPassword('admin@smartrecruit.local', 'admin123'))!
  const originalPasswordHash = (await store.findUserForPasswordAuthentication(original.email, 'admin123'))!.passwordHash
  await store.createWorkspace(original.id, { name: '合成安全测试企业', kind: 'test' })
  const login = await store.createSession(original)
  const auth: AuthContext = { user: original, sessionId: login.session.sessionId, method: 'session' }
  const request = { newEmail: 'verified@example.invalid', currentPassword: 'admin123' }
  const snapshot = async () => JSON.parse(await readFile(path, 'utf8'))
  const alter = async (operation: (file: any) => void) => { const file = await snapshot(); operation(file); await writeFile(path, JSON.stringify(file)) }
  const age = () => alter(file => { for (const item of file.emailVerificationChallenges) item.createdAt = new Date(Date.now() - 61_000).toISOString() })

  await assert.rejects(service.requestEmailChangeCode({ ...auth, method: 'development-bootstrap' }, request), { code: 'AUTHENTICATION_REQUIRED' })
  await assert.rejects(service.changePassword(auth, { currentPassword: 'wrong', newPassword: 'new-password-test' }), { code: 'INVALID_CURRENT_PASSWORD' })
  await assert.rejects(service.requestEmailChangeCode(auth, { ...request, newEmail: original.email.toUpperCase() }), { code: 'VALIDATION_ERROR' })
  await assert.rejects(service.requestEmailChangeCode(auth, { ...request, newEmail: 'reserved@example.invalid' }), { code: 'EMAIL_NOT_AVAILABLE' })
  await assert.rejects(service.requestEmailChangeCode(auth, { ...request, newEmail: 'recruiter@smartrecruit.local' }), { code: 'EMAIL_ALREADY_EXISTS' })
  await assert.rejects(service.confirmEmailChange(auth, { ...request, verificationCode: '123456' }), { code: 'INVALID_VERIFICATION_CODE' })

  rejectMail = true
  await assert.rejects(service.requestEmailChangeCode(auth, request), { code: 'VERIFICATION_MAIL_UNAVAILABLE' })
  await assert.rejects(service.confirmEmailChange(auth, { ...request, verificationCode: code }), { code: 'INVALID_VERIFICATION_CODE' })
  assert.ok((await snapshot()).emailVerificationChallenges[0].invalidatedAt)
  rejectMail = false
  await age()
  let releaseMail!: () => void
  holdMail = new Promise<void>(resolve => { releaseMail = resolve })
  const pendingMail = service.requestEmailChangeCode(auth, request)
  for (let i = 0; i < 100 && (await snapshot()).emailVerificationChallenges.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5))
  await assert.rejects(service.confirmEmailChange(auth, { ...request, verificationCode: code }), { code: 'INVALID_VERIFICATION_CODE' })
  releaseMail(); await pendingMail; holdMail = undefined
  await assert.rejects(service.requestEmailChangeCode(auth, request), { code: 'VERIFICATION_RATE_LIMITED' })
  const wrongCode = code === '000000' ? '111111' : '000000'
  for (let i = 0; i < 5; i++) await assert.rejects(service.confirmEmailChange(auth, { ...request, verificationCode: wrongCode }), { code: 'INVALID_VERIFICATION_CODE' })
  await assert.rejects(service.confirmEmailChange(auth, { ...request, verificationCode: code }), { code: 'INVALID_VERIFICATION_CODE' })
  await age()
  await service.requestEmailChangeCode(auth, request)
  await alter(file => { file.emailVerificationChallenges.at(-1).expiresAt = new Date(Date.now() - 1_000).toISOString() })
  await assert.rejects(service.confirmEmailChange(auth, { ...request, verificationCode: code }), { code: 'INVALID_VERIFICATION_CODE' })
  await age()
  await service.requestEmailChangeCode(auth, request)
  const otherUser = (await store.findUserByEmailPassword('recruiter@smartrecruit.local', 'recruiter123'))!
  const otherLogin = await store.createSession(otherUser)
  await assert.rejects(service.confirmEmailChange({ user: otherUser, method: 'session', sessionId: otherLogin.session.sessionId }, { ...request, currentPassword: 'recruiter123', verificationCode: code }), { code: 'INVALID_VERIFICATION_CODE' })
  await assert.rejects(service.confirmEmailChange(auth, { ...request, newEmail: 'different@example.invalid', verificationCode: code }), { code: 'INVALID_VERIFICATION_CODE' })
  await store.createEmailVerificationChallenge({ purpose: 'password_reset', email: original.email, codeHash: hashVerificationCode('password_reset', original.email, '654321', env.AUTH_OTP_HMAC_SECRET), expiresInMs: 600_000, maxAttempts: 5 })
  await alter(file => { file.mfaCredentials = [{ userId: original.id, secretEncrypted: 'preserved-secret', recoveryCodeHashes: ['preserved-code'] }] })
  const before = await snapshot()
  const confirmations = await Promise.allSettled([
    service.confirmEmailChange(auth, { ...request, newEmail: request.newEmail.toUpperCase(), verificationCode: code }),
    service.confirmEmailChange(auth, { ...request, verificationCode: code }),
  ])
  assert.equal(confirmations.filter(result => result.status === 'fulfilled').length, 1)
  const after = await snapshot()
  const updated = after.users.find((item: any) => item.id === original.id)
  const previous = before.users.find((item: any) => item.id === original.id)
  const { email: _oldEmail, emailVerifiedAt: _oldVerification, ...previousIdentity } = previous
  const { email: _newEmail, emailVerifiedAt: _newVerification, ...updatedIdentity } = updated
  assert.deepEqual(updatedIdentity, previousIdentity)
  assert.equal(updated.email, request.newEmail)
  assert.deepEqual(after.workspaces, before.workspaces)
  assert.deepEqual(after.workspaceMembers, before.workspaceMembers)
  assert.deepEqual(after.mfaCredentials, before.mfaCredentials)
  assert.equal(await store.findSessionByToken(login.token), undefined)
  assert.equal(await store.findUserByEmailPassword(original.email, 'admin123'), undefined)
  assert.ok(after.emailVerificationChallenges.find((item: any) => item.purpose === 'password_reset').invalidatedAt)
  assert.equal((await store.findUserByEmailPassword(request.newEmail, 'admin123'))?.id, original.id)
  await assert.rejects(store.createSession(original, undefined, { expectedPasswordHash: originalPasswordHash }), { code: 'ACCOUNT_SESSION_CHANGED' })

  const nextLogin = await store.createSession({ ...original, email: request.newEmail })
  const nextAuth: AuthContext = { user: { ...original, email: request.newEmail }, sessionId: nextLogin.session.sessionId, method: 'session' }
  await assert.rejects(service.confirmEmailChange(nextAuth, { newEmail: 'third@example.invalid', currentPassword: 'admin123', verificationCode: code }), { code: 'INVALID_VERIFICATION_CODE' })
  const pendingMfa = await store.createMfaChallenge({ userId: original.id, tokenHash: 'synthetic-pending-mfa', kind: 'login', expiresInMs: 300_000, maxAttempts: 5, expectedPasswordHash: originalPasswordHash })
  await alter(file => { file.mfaChallenges.find((item: any) => item.id === pendingMfa.id).consumedAt = new Date().toISOString() })
  await service.changePassword(nextAuth, { currentPassword: 'admin123', newPassword: 'new-password-test' })
  assert.equal(await store.findUserByEmailPassword(request.newEmail, 'admin123'), undefined)
  assert.equal((await store.findUserByEmailPassword(request.newEmail, 'new-password-test'))?.id, original.id)
  assert.equal(await store.findSessionByToken(nextLogin.token), undefined)
  assert.deepEqual((await snapshot()).mfaCredentials, before.mfaCredentials)
  await assert.rejects(store.createSession(nextAuth.user, undefined, { expectedPasswordHash: originalPasswordHash }), { code: 'ACCOUNT_SESSION_CHANGED' })
  await assert.rejects(store.createSession(nextAuth.user, undefined, { mfaChallengeId: pendingMfa.id }), { code: 'ACCOUNT_SESSION_CHANGED' })
  await assert.rejects(store.createMfaChallenge({ userId: original.id, tokenHash: 'synthetic-stale-login', kind: 'login', expiresInMs: 300_000, maxAttempts: 5, expectedPasswordHash: originalPasswordHash }), { code: 'ACCOUNT_SESSION_CHANGED' })
})
