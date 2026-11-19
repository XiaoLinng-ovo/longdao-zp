import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AuthService } from './auth-service.js'
import { LocalAuthSessionStore } from './session-store.js'
import { encryptMfaSecret, generateTotpSecret } from './totp.js'
import { hashVerificationCode } from './verification-code.js'

const verificationSecret = 'test-verification-secret-at-least-32-characters'

test('registration consumes one verification challenge under concurrent requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-auth-'))
  const storePath = join(directory, 'auth-sessions.json')
  try {
    const env = { NODE_ENV: 'test', AUTH_OTP_HMAC_SECRET: verificationSecret } as NodeJS.ProcessEnv
    const store = new LocalAuthSessionStore(storePath)
    const email = 'concurrent-owner@example.com'
    const code = '123456'
    const challenge = await store.createEmailVerificationChallenge({
      purpose: 'registration',
      email,
      codeHash: hashVerificationCode('registration', email, code, verificationSecret),
      expiresInMs: 10 * 60_000,
      maxAttempts: 5,
    })
    assert.ok(challenge.challenge)

    const service = new AuthService(store, { env })
    const registration = {
      name: '并发注册用户',
      email,
      password: 'strong-password',
      companyName: '并发测试企业',
      verificationCode: code,
    }
    const attempts = await Promise.allSettled([
      service.register(registration),
      service.register(registration),
    ])

    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = attempts.find((result) => result.status === 'rejected')
    assert.ok(rejected && rejected.status === 'rejected')
    assert.equal((rejected.reason as { code?: string }).code, 'INVALID_VERIFICATION_CODE')

    const stored = JSON.parse(await readFile(storePath, 'utf8')) as {
      users: Array<{ email: string }>
      workspaces: Array<{ name: string }>
      workspaceMembers: Array<{ workspaceId: string; userId: string; role: string }>
      emailVerificationChallenges: Array<{ consumedAt?: string; invalidatedAt?: string }>
    }
    assert.equal(stored.users.filter((user) => user.email === email).length, 1)
    assert.equal(stored.workspaces.filter((workspace) => workspace.name === '并发测试企业').length, 1)
    assert.equal(stored.workspaceMembers.filter((member) => member.role === 'owner').length, 1)
    assert.equal(stored.emailVerificationChallenges.filter((item) => item.consumedAt).length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('password reset confirmation rejects a Turnstile token from the request step', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-auth-turnstile-'))
  try {
    let verificationRequest: URLSearchParams | undefined
    const service = new AuthService(new LocalAuthSessionStore(join(directory, 'auth-sessions.json')), {
      env: {
        NODE_ENV: 'test',
        AUTH_OTP_HMAC_SECRET: verificationSecret,
        TURNSTILE_ENABLED: 'true',
        TURNSTILE_SITE_KEY: 'test-site-key',
        TURNSTILE_SECRET_KEY: 'test-secret-key',
      } as NodeJS.ProcessEnv,
      turnstileFetcher: async (_input, init) => {
        verificationRequest = init?.body as URLSearchParams
        return new Response(JSON.stringify({ success: true, action: 'password-reset' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await assert.rejects(
      service.confirmPasswordReset({
        email: 'owner@example.com',
        verificationCode: '123456',
        password: 'new-password',
        ipAddress: '203.0.113.10',
        turnstileToken: 'request-step-token',
      }),
      (error: { code?: string }) => error.code === 'TURNSTILE_ACTION_MISMATCH',
    )
    assert.equal(verificationRequest?.get('remoteip'), '203.0.113.10')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('repeated MFA failures consume the persistent login attempt limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-auth-mfa-limit-'))
  const storePath = join(directory, 'auth-sessions.json')
  try {
    const env = {
      NODE_ENV: 'test',
      AUTH_OTP_HMAC_SECRET: verificationSecret,
      AUTH_MFA_ENCRYPTION_KEY: 'test-mfa-encryption-key-at-least-32-characters',
      AUTH_MFA_REQUIRED: 'true',
    } as NodeJS.ProcessEnv
    const store = new LocalAuthSessionStore(storePath)
    const registration = await store.registerUser({
      name: 'MFA 限流用户',
      email: 'mfa-limit@example.com',
      password: 'strong-password',
      companyName: 'MFA 限流测试企业',
    })
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as {
      mfaCredentials: Array<{
        userId: string
        secretEncrypted: string
        recoveryCodeHashes: string[]
        enabledAt: string
      }>
    }
    stored.mfaCredentials.push({
      userId: registration.user.id,
      secretEncrypted: encryptMfaSecret(generateTotpSecret(), env.AUTH_MFA_ENCRYPTION_KEY),
      recoveryCodeHashes: [],
      enabledAt: new Date().toISOString(),
    })
    await writeFile(storePath, JSON.stringify(stored), 'utf8')

    const service = new AuthService(store, { env })
    for (let index = 0; index < 5; index += 1) {
      const login = await service.login({ email: registration.user.email, password: 'strong-password' })
      assert.equal(login.kind, 'mfa_required')
      if (login.kind !== 'mfa_required') continue
      await assert.rejects(
        service.verifyMfa({ challengeToken: login.challengeToken, code: 'invalid-mfa-code' }),
        (error: { code?: string }) => error.code === 'INVALID_MFA_CODE',
      )
    }

    await assert.rejects(
      service.login({ email: registration.user.email, password: 'strong-password' }),
      (error: { code?: string }) => error.code === 'LOGIN_RATE_LIMITED',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('password login ignores enrolled MFA and Turnstile while MFA is disabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-auth-mfa-disabled-'))
  const storePath = join(directory, 'auth-sessions.json')
  try {
    const env = {
      NODE_ENV: 'production',
      AUTH_OTP_HMAC_SECRET: verificationSecret,
      AUTH_MFA_ENCRYPTION_KEY: 'test-mfa-encryption-key-at-least-32-characters',
      AUTH_MFA_REQUIRED: 'false',
      TURNSTILE_ENABLED: 'true',
      TURNSTILE_SITE_KEY: 'test-site-key',
      TURNSTILE_SECRET_KEY: 'test-secret-key',
    } as NodeJS.ProcessEnv
    const store = new LocalAuthSessionStore(storePath)
    const registration = await store.registerUser({
      name: '已有 MFA 用户',
      email: 'existing-mfa@example.com',
      password: 'strong-password',
      companyName: '已有 MFA 测试企业',
    })
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as {
      mfaCredentials: Array<{ userId: string; secretEncrypted: string; recoveryCodeHashes: string[]; enabledAt: string }>
    }
    stored.mfaCredentials.push({
      userId: registration.user.id,
      secretEncrypted: encryptMfaSecret(generateTotpSecret(), env.AUTH_MFA_ENCRYPTION_KEY),
      recoveryCodeHashes: [],
      enabledAt: new Date().toISOString(),
    })
    await writeFile(storePath, JSON.stringify(stored), 'utf8')

    let turnstileCalled = false
    const service = new AuthService(store, {
      env,
      turnstileFetcher: async () => {
        turnstileCalled = true
        throw new Error('login must not call Turnstile')
      },
    })
    const login = await service.login({ email: registration.user.email, password: 'strong-password' })

    assert.equal(login.kind, 'authenticated')
    assert.equal(turnstileCalled, false)
    assert.equal(service.getSecurityConfig().adminMfaRequired, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('AUTH_MFA_REQUIRED does not treat historical hr_admin accounts as system administrators', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-auth-hr-admin-mfa-'))
  try {
    const service = new AuthService(new LocalAuthSessionStore(join(directory, 'auth-sessions.json')), {
      env: {
        NODE_ENV: 'production',
        AUTH_OTP_HMAC_SECRET: verificationSecret,
        AUTH_MFA_ENCRYPTION_KEY: 'test-mfa-encryption-key-at-least-32-characters',
        AUTH_MFA_REQUIRED: 'true',
        AUTH_MFA_EXEMPT_EMAILS: 'admin@smartrecruit.local',
      } as NodeJS.ProcessEnv,
    })

    const login = await service.login({
      email: 'hr@smartrecruit.local',
      password: 'hr123',
    })

    assert.equal(login.kind, 'authenticated')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('configured MFA-exempt administrator signs in with a password only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-auth-mfa-exempt-'))
  const storePath = join(directory, 'auth-sessions.json')
  try {
    const env = {
      NODE_ENV: 'production',
      AUTH_OTP_HMAC_SECRET: verificationSecret,
      AUTH_MFA_ENCRYPTION_KEY: 'test-mfa-encryption-key-at-least-32-characters',
      AUTH_MFA_REQUIRED: 'true',
      AUTH_MFA_EXEMPT_EMAILS: 'admin@smartrecruit.local',
    } as NodeJS.ProcessEnv
    const store = new LocalAuthSessionStore(storePath)
    assert.ok(await store.findUserByEmailPassword('admin@smartrecruit.local', 'admin123'))
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as {
      users: Array<{ id: string; role: string }>
      mfaCredentials: Array<{ userId: string; secretEncrypted: string; recoveryCodeHashes: string[]; enabledAt: string }>
    }
    const user = stored.users.find((item) => item.id === 'user-admin')
    assert.ok(user)
    user.role = 'admin'
    stored.mfaCredentials.push({
      userId: user.id,
      secretEncrypted: encryptMfaSecret(generateTotpSecret(), env.AUTH_MFA_ENCRYPTION_KEY),
      recoveryCodeHashes: [],
      enabledAt: new Date().toISOString(),
    })
    await writeFile(storePath, JSON.stringify(stored), 'utf8')

    const service = new AuthService(store, { env })
    const login = await service.login({ email: 'ADMIN@SMARTRECRUIT.LOCAL', password: 'admin123' })
    assert.equal(login.kind, 'authenticated')

    await assert.rejects(
      service.login({ email: 'admin@smartrecruit.local', password: 'wrong-password' }),
      (error: { code?: string }) => error.code === 'INVALID_CREDENTIALS',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('password reset clears an unrecognized MFA binding so an administrator can set it up again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-auth-mfa-recovery-'))
  const storePath = join(directory, 'auth-sessions.json')
  try {
    const env = {
      NODE_ENV: 'production',
      AUTH_OTP_HMAC_SECRET: verificationSecret,
      AUTH_MFA_ENCRYPTION_KEY: 'test-mfa-encryption-key-at-least-32-characters',
      AUTH_MFA_REQUIRED: 'true',
    } as NodeJS.ProcessEnv
    const store = new LocalAuthSessionStore(storePath)
    const registration = await store.registerUser({
      name: 'MFA 恢复用户',
      email: 'mfa-recovery@example.com',
      password: 'strong-password',
      companyName: 'MFA 恢复测试企业',
    })
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as {
      users: Array<{ id: string; email: string; role: string }>
      mfaCredentials: Array<{ userId: string; secretEncrypted: string; recoveryCodeHashes: string[]; enabledAt: string }>
    }
    const user = stored.users.find((item) => item.id === registration.user.id)
    assert.ok(user)
    user.role = 'admin'
    stored.mfaCredentials.push({
      userId: registration.user.id,
      secretEncrypted: encryptMfaSecret(generateTotpSecret(), env.AUTH_MFA_ENCRYPTION_KEY),
      recoveryCodeHashes: [],
      enabledAt: new Date().toISOString(),
    })
    await writeFile(storePath, JSON.stringify(stored), 'utf8')

    const code = '654321'
    await store.createEmailVerificationChallenge({
      purpose: 'password_reset',
      email: registration.user.email,
      codeHash: hashVerificationCode('password_reset', registration.user.email, code, verificationSecret),
      expiresInMs: 10 * 60_000,
      maxAttempts: 5,
    })
    const service = new AuthService(store, { env })
    await service.confirmPasswordReset({
      email: registration.user.email,
      verificationCode: code,
      password: 'replacement-password',
    })

    assert.equal(await store.getMfaCredential(registration.user.id), undefined)
    const login = await service.login({ email: registration.user.email, password: 'replacement-password' })
    assert.equal(login.kind, 'authenticated')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('current user profile updates only contact fields and persists them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-auth-profile-'))
  try {
    const store = new LocalAuthSessionStore(join(directory, 'auth-sessions.json'))
    const registration = await store.registerUser({
      name: '原姓名',
      email: 'profile-update@example.com',
      phone: '13800000000',
      password: 'strong-password',
      companyName: '个人资料测试企业',
    })
    const service = new AuthService(store, { env: { NODE_ENV: 'test' } as NodeJS.ProcessEnv })

    const currentUser = await store.findUserByEmailPassword(registration.user.email, 'strong-password')
    assert.ok(currentUser)
    const updated = await service.updateCurrentUserProfile(currentUser, {
      name: '更新后的姓名',
      phone: '13900000000',
    })
    assert.equal(updated.name, '更新后的姓名')
    assert.equal(updated.phone, '13900000000')
    assert.equal(updated.role, registration.user.role)
    assert.equal(updated.workspaceId, registration.user.workspaceId)

    const persisted = await store.findUserByEmailPassword(registration.user.email, 'strong-password')
    assert.equal(persisted?.name, '更新后的姓名')
    assert.equal(persisted?.phone, '13900000000')

    await assert.rejects(
      service.updateCurrentUserProfile(currentUser, { name: '提权尝试', role: 'admin' }),
      (error: { code?: string }) => error.code === 'PROFILE_FIELDS_NOT_ALLOWED',
    )
    await assert.rejects(
      service.updateCurrentUserProfile(currentUser, { name: 'x'.repeat(51) }),
      (error: { code?: string }) => error.code === 'PROFILE_NAME_INVALID',
    )
    assert.equal((await store.findUserByEmailPassword(registration.user.email, 'strong-password'))?.role, registration.user.role)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
