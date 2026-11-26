import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { startLocalSmtpBoundary, verificationCodeFromMime } from './local-smtp-boundary.mjs'
import { ephemeralLoopbackPort, isolatedBrowserIngress } from './isolated-browser-ingress.mjs'
import { launchIsolatedBrowser } from './isolated-browser-launch.mjs'

const arg = process.argv.indexOf('--postgres-bin')
assert.ok(arg >= 0 && process.argv[arg + 1], 'Explicit isolated PostgreSQL binaries required')
const runtimeModules = process.env.CODEX_NODE_MODULES || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules')
const chrome = process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe') : undefined
const instance = await startIsolatedPostgres(process.argv[arg + 1])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env, { AUTH_MFA_REQUIRED: 'false', AUTH_OTP_HMAC_SECRET: randomBytes(40).toString('hex') })
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
const { Pool } = require('pg')
const admin = new Pool(instance.connection)
const guard = require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
const load = file => import(pathToFileURL(join(projectRoot, 'apps/api/dist/src', file + '.js')).href)
const ingress = isolatedBrowserIngress()
const report = { checks: [], pageErrors: [], cleanup: {}, isolated: true }
const output = join(instance.directory, 'account-credentials-report.json')
let pool, smtp, api, vite, browser, page, origin, created = false
async function check(name, action) {
  console.log('Check: ' + name)
  await action()
  report.checks.push(name)
}
async function json(target, path, body, csrf = true) {
  return target.evaluate(async ({ path, body, csrf }) => {
    const cookie = document.cookie.split('; ').find(item => item.startsWith('smartrecruit_csrf='))?.slice('smartrecruit_csrf='.length)
    const response = await fetch('/api/v1' + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      'content-type': 'application/json', ...(csrf && cookie ? { 'x-csrf-token': decodeURIComponent(cookie) } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }, { path, body, csrf })
}
async function responseAfter(path, action, status = 200) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1' + path && response.request().method() === 'POST')
  await action()
  const response = await pending
  assert.equal(response.status(), status, await response.text())
  return (await response.json()).data
}
async function contextPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await context.addCookies([ingress.cookie(origin)])
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const result = await context.newPage()
  result.setDefaultTimeout(15000)
  result.on('pageerror', error => report.pageErrors.push(error.message))
  return result
}
async function login(email, password) {
  await page.goto(origin + '/login?redirect=%2Fprofile')
  await page.getByLabel('\u90ae\u7bb1', { exact: true }).fill(email)
  await page.locator('#login-password').fill(password)
  await responseAfter('/auth/login', () => page.getByRole('button', { name: '\u767b\u5f55\u5de5\u4f5c\u7a7a\u95f4', exact: true }).click())
  await page.waitForURL(origin + '/profile')
  await page.getByRole('button', { name: '更换邮箱', exact: true }).waitFor()
  const identity = (await json(page, '/me')).body.data.user
  assert.equal(identity.userNo, process.env.SYSTEM_ADMIN_USER_NO)
  assert.equal(identity.isSystemAdmin, true)
  assert.equal(identity.platformRole, 'admin')
}
async function snapshot(userId) {
  return {
    identity: (await pool.query(`SELECT to_jsonb(u)-'email'-'email_verified_at'-'password_hash'-'updated_at'-'last_login_at' AS data FROM users u WHERE id=$1`, [userId])).rows,
    memberships: (await pool.query('SELECT * FROM organization_members WHERE user_id=$1 ORDER BY organization_id', [userId])).rows,
    operator: (await pool.query('SELECT * FROM platform_operators WHERE user_id=$1', [userId])).rows,
    mfa: (await pool.query('SELECT * FROM user_mfa_credentials WHERE user_id=$1', [userId])).rows,
  }
}
async function captureDialog(dialog, name) {
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    const box = await dialog.boundingBox()
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height)
    assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await dialog.screenshot({ path: join(instance.directory, name + '-' + viewport.width + '.png') })
  }
  await page.setViewportSize({ width: 1440, height: 1100 })
}
try {
  assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  await admin.query('CREATE DATABASE "' + instance.database + '"'); created = true
  pool = new Pool({ ...instance.connection, database: instance.database })
  await mkdir(process.env.RECRUITING_QUARANTINE_ROOT)
  await mkdir(process.env.INTERVIEW_STORAGE_ROOT)
  const smtpPassword = randomBytes(24).toString('hex')
  smtp = await startLocalSmtpBoundary({ user: 'sender@example.invalid', password: smtpPassword })
  guard.allowLoopbackPort(smtp.port)
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false', SMTP_USER: 'sender@example.invalid', SMTP_PASSWORD: smtpPassword, SMTP_FROM: 'sender@example.invalid' })
  const { runMigrations } = await load('db/migrations')
  await check('all migrations run in a fresh isolated database', async () => {
    report.migrations = (await runMigrations(pool, join(projectRoot, 'db/migrations'))).applied.length
  })
  const { PostgresSessionRepository } = await load('auth/session-repository')
  const { AuthService } = await load('auth/auth-service')
  const store = new PostgresSessionRepository(pool), service = new AuthService(store)
  const password = randomBytes(20).toString('base64url'), email = 'profile@example.invalid', newEmail = 'verified-profile@example.invalid'
  async function signup(address) {
    await service.requestRegistrationCode({ email: address })
    return service.register({ companyName: 'Synthetic Account Security', name: 'Synthetic User', email: address, password, verificationCode: verificationCodeFromMime(smtp.messages.at(-1).raw) })
  }
  const registered = await signup(email), other = await signup('other@example.invalid')
  const userId = registered.user.id
  process.env.SYSTEM_ADMIN_USER_NO = registered.user.userNo
  await pool.query("INSERT INTO platform_operators(user_id,role) VALUES ($1,'admin')", [userId])
  await pool.query("INSERT INTO user_mfa_credentials(user_id,secret_encrypted,recovery_code_hashes) VALUES ($1,'synthetic-preserved-secret','[\"synthetic-recovery\"]')", [userId])
  const before = await snapshot(userId)
  const staleAuthentication = await store.findUserForPasswordAuthentication(email, password)
  const { startServer } = await load('server'), { loadConfig } = await load('config')
  const frontendPort = await ephemeralLoopbackPort()
  origin = 'http://127.0.0.1:' + frontendPort
  process.env.ALLOWED_ORIGINS = origin
  api = await startServer(loadConfig({ ...process.env, HOST: '127.0.0.1', PORT: '0' }))
  guard.allowLoopbackPort(api.address().port)
  const webRequire = createRequire(join(projectRoot, 'web/package.json'))
  const { createServer } = await import(pathToFileURL(join(projectRoot, 'web/node_modules/vite/dist/node/index.js')).href)
  const { default: vue } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-vue')).href)
  vite = await createServer({ root: join(projectRoot, 'web'), configFile: false, envFile: false, plugins: [ingress.plugin, vue()], server: {
    host: '127.0.0.1', port: frontendPort, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:' + api.address().port } },
  } })
  await vite.listen()
  guard.allowLoopbackPort(frontendPort)
  const runtime = createRequire(join(runtimeModules, 'playwright/package.json'))
  browser = (await launchIsolatedBrowser(runtime('playwright').chromium, { channel: 'chrome', ...(chrome ? { executablePath: chrome } : {}), headless: true })).browser
  page = await contextPage()
  await login(email, password)
  const emailForm = page.getByRole('dialog', { name: '更换邮箱', exact: true })
  const passwordForm = page.getByRole('dialog', { name: '修改密码', exact: true })
  await check('desktop and mobile profile render without overflow or framework errors', async () => {
    for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      assert.equal(await page.locator('vite-error-overlay').count(), 0)
      await page.getByRole('button', { name: '更换邮箱', exact: true }).click()
      assert.ok(await emailForm.isVisible())
      assert.equal(await emailForm.locator('input[type="password"]').count(), 0)
      await emailForm.screenshot({ path: join(instance.directory, 'email-dialog-' + viewport.width + '.png') })
      await emailForm.getByRole('button', { name: '关闭', exact: true }).click()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
      await page.screenshot({ path: join(instance.directory, 'profile-' + viewport.width + '.png'), fullPage: true })
    }
    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.getByRole('button', { name: '修改密码', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(instance.directory, 'profile-security-desktop.png') })
  })
  await check('CSRF, missing OTP and wrong current password are denied without changing data', async () => {
    assert.equal((await json(page, '/auth/account/password', { currentPassword: password, newPassword: 'must-not-apply' }, false)).status, 403)
    assert.equal((await json(page, '/auth/account/email', { currentPassword: password, newEmail, verificationCode: '123456' })).body.error.code, 'INVALID_VERIFICATION_CODE')
    assert.equal((await json(page, '/auth/account/password/code', {}, false)).status, 403)
    assert.equal((await json(page, '/auth/account/password/verify', { verificationCode: '123456' }, false)).status, 403)
    assert.equal((await json(page, '/auth/account/password', { currentPassword: 'wrong-password', newPassword: 'must-not-apply' })).status, 400)
    assert.equal((await json(page, '/me')).status, 200)
    assert.deepEqual(await snapshot(userId), before)
  })
  const otherPage = await contextPage()
  await otherPage.goto(origin + '/login')
  assert.equal((await json(otherPage, '/auth/login', { email, password })).status, 200)
  let code
  await check('real SMTP delivery, destination binding, wrong-code rejection and successful email change', async () => {
    await page.getByRole('button', { name: '更换邮箱', exact: true }).click()
    await emailForm.getByLabel('新邮箱', { exact: true }).fill(newEmail)
    await responseAfter('/auth/account/email/code', () => emailForm.getByRole('button', { name: '\u53d1\u9001\u9a8c\u8bc1\u7801', exact: true }).click())
    assert.ok(smtp.messages.at(-1).recipients.includes(newEmail))
    code = verificationCodeFromMime(smtp.messages.at(-1).raw)
    await captureDialog(emailForm, 'email-code')
    assert.equal((await pool.query('SELECT email FROM users WHERE id=$1', [userId])).rows[0].email, email)
    assert.equal((await json(page, '/auth/account/email', { currentPassword: password, newEmail: 'wrong-destination@example.invalid', verificationCode: code })).status, 400)
    await emailForm.getByLabel('\u65b0\u90ae\u7bb1\u9a8c\u8bc1\u7801', { exact: true }).fill(code === '000000' ? '111111' : '000000')
    await responseAfter('/auth/account/email', () => emailForm.getByRole('button', { name: '\u9a8c\u8bc1\u5e76\u66f4\u6362', exact: true }).click(), 400)
    await emailForm.getByRole('alert').waitFor()
    await emailForm.getByLabel('\u65b0\u90ae\u7bb1\u9a8c\u8bc1\u7801', { exact: true }).fill(code)
    await responseAfter('/auth/account/email', () => emailForm.getByRole('button', { name: '\u9a8c\u8bc1\u5e76\u66f4\u6362', exact: true }).click())
    await emailForm.getByRole('button', { name: '重新登录', exact: true }).waitFor()
    await captureDialog(emailForm, 'email-success')
    assert.ok((await emailForm.textContent()).includes(newEmail))
    await emailForm.getByRole('button', { name: '重新登录', exact: true }).click()
    await page.waitForURL(url => url.pathname === '/login' && !url.searchParams.has('credentials'))
    assert.equal((await json(otherPage, '/me')).status, 401)
    assert.equal((await json(page, '/auth/login', { email, password })).status, 401)
    assert.deepEqual(await snapshot(userId), before)
    await assert.rejects(store.createSession(staleAuthentication.user, undefined, { expectedPasswordHash: staleAuthentication.passwordHash }), { code: 'ACCOUNT_SESSION_CHANGED' })
  })
  await login(newEmail, password)
  const updatedAuth = await store.findUserForPasswordAuthentication(newEmail, password)
  const pendingMfa = await store.createMfaChallenge({ userId, tokenHash: randomBytes(32).toString('hex'), kind: 'login', maxAttempts: 5, expiresInMs: 300_000, expectedPasswordHash: updatedAuth.passwordHash })
  await pool.query('UPDATE mfa_login_challenges SET consumed_at=now() WHERE id=$1', [pendingMfa.id])
  await check('OTP cannot be replayed in a new session or for another account', async () => {
    const otherAuth = { user: other.user, sessionId: other.session.sessionId, method: 'session' }
    await assert.rejects(service.confirmEmailChange(otherAuth, { currentPassword: password, newEmail, verificationCode: code }), { code: 'INVALID_VERIFICATION_CODE' })
    assert.equal((await json(page, '/auth/account/email', { currentPassword: password, newEmail: 'another@example.invalid', verificationCode: code })).status, 400)
  })
  const nextPassword = randomBytes(20).toString('base64url')
  await check('password mismatch is local; successful change revokes stale password and MFA logins', async () => {
    await page.getByRole('button', { name: '修改密码', exact: true }).click()
    await captureDialog(passwordForm, 'password-address')
    await responseAfter('/auth/account/password/code', () => passwordForm.getByRole('button', { name: '发送验证码', exact: true }).click())
    assert.ok(smtp.messages.at(-1).recipients.includes(newEmail))
    const passwordCode = verificationCodeFromMime(smtp.messages.at(-1).raw)
    await captureDialog(passwordForm, 'password-code')
    await passwordForm.getByLabel('邮箱验证码', { exact: true }).fill(passwordCode === '000000' ? '111111' : '000000')
    await responseAfter('/auth/account/password/verify', () => passwordForm.getByRole('button', { name: '下一步', exact: true }).click(), 400)
    assert.equal(await passwordForm.locator('input[type="password"]').count(), 0)
    await passwordForm.getByLabel('邮箱验证码', { exact: true }).fill(passwordCode)
    await responseAfter('/auth/account/password/verify', () => passwordForm.getByRole('button', { name: '下一步', exact: true }).click())
    await captureDialog(passwordForm, 'password-new')
    await passwordForm.locator('input[autocomplete="new-password"]').nth(0).fill(nextPassword)
    await passwordForm.getByLabel('\u786e\u8ba4\u65b0\u5bc6\u7801', { exact: true }).fill('different-password')
    await passwordForm.getByRole('button', { name: '确认修改密码', exact: true }).click()
    await passwordForm.getByRole('alert').waitFor()
    assert.ok(await store.findUserByEmailPassword(newEmail, password))
    await passwordForm.getByLabel('\u786e\u8ba4\u65b0\u5bc6\u7801', { exact: true }).fill(nextPassword)
    await responseAfter('/auth/account/password', () => passwordForm.getByRole('button', { name: '确认修改密码', exact: true }).click())
    await passwordForm.getByRole('button', { name: '重新登录', exact: true }).waitFor()
    await captureDialog(passwordForm, 'password-success')
    await passwordForm.getByRole('button', { name: '重新登录', exact: true }).click()
    await page.waitForURL(url => url.pathname === '/login' && !url.searchParams.has('credentials'))
    assert.equal((await json(page, '/auth/login', { email: newEmail, password })).status, 401)
    await assert.rejects(store.createSession(updatedAuth.user, undefined, { expectedPasswordHash: updatedAuth.passwordHash }), { code: 'ACCOUNT_SESSION_CHANGED' })
    await assert.rejects(store.createSession(updatedAuth.user, undefined, { mfaChallengeId: pendingMfa.id }), { code: 'ACCOUNT_SESSION_CHANGED' })
    await assert.rejects(store.createMfaChallenge({ userId, tokenHash: randomBytes(32).toString('hex'), kind: 'login', maxAttempts: 5, expiresInMs: 300_000, expectedPasswordHash: updatedAuth.passwordHash }), { code: 'ACCOUNT_SESSION_CHANGED' })
    await login(newEmail, nextPassword)
    assert.deepEqual(await snapshot(userId), before)
    assert.equal((await json(page, '/me')).body.data.user.id, userId)
  })
  await check('real PostgreSQL rejects a newly occupied address, expired codes, excess attempts and concurrent replay', async () => {
    const auth = { user: other.user, sessionId: other.session.sessionId, method: 'session' }
    const target = 'transaction@example.invalid', request = { currentPassword: password, newEmail: target }
    const age = () => pool.query("UPDATE email_verification_challenges SET created_at=now()-interval '61 seconds' WHERE user_id=$1", [other.user.id])
    await service.requestEmailChangeCode(auth, request)
    const firstCode = verificationCodeFromMime(smtp.messages.at(-1).raw)
    await pool.query('UPDATE users SET email=$2 WHERE id=$1', [userId, target])
    await assert.rejects(service.confirmEmailChange(auth, { ...request, verificationCode: firstCode }), { code: 'EMAIL_ALREADY_EXISTS' })
    await pool.query('UPDATE users SET email=$2 WHERE id=$1', [userId, newEmail])
    await pool.query("UPDATE users SET is_active=false WHERE id=$1", [userId])
    await assert.rejects(service.requestEmailChangeCode(auth, { ...request, newEmail }), { code: 'EMAIL_ALREADY_EXISTS' })
    await pool.query("UPDATE users SET is_active=true WHERE id=$1", [userId])
    await pool.query("UPDATE email_verification_challenges SET expires_at=now()-interval '1 second' WHERE user_id=$1", [other.user.id])
    await assert.rejects(service.confirmEmailChange(auth, { ...request, verificationCode: firstCode }), { code: 'INVALID_VERIFICATION_CODE' })
    await age(); await service.requestEmailChangeCode(auth, request)
    const secondCode = verificationCodeFromMime(smtp.messages.at(-1).raw)
    for (let i = 0; i < 5; i++) await assert.rejects(service.confirmEmailChange(auth, { ...request, verificationCode: secondCode === '000000' ? '111111' : '000000' }), { code: 'INVALID_VERIFICATION_CODE' })
    await assert.rejects(service.confirmEmailChange(auth, { ...request, verificationCode: secondCode }), { code: 'INVALID_VERIFICATION_CODE' })
    await age(); await service.requestEmailChangeCode(auth, request)
    const thirdCode = verificationCodeFromMime(smtp.messages.at(-1).raw)
    const results = await Promise.allSettled([service.confirmEmailChange(auth, { ...request, verificationCode: thirdCode }), service.confirmEmailChange(auth, { ...request, verificationCode: thirdCode })])
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM email_verification_challenges WHERE user_id=$1 AND consumed_at IS NOT NULL", [other.user.id])).rows[0].count, 1)
  })
  await check('password OTP expiry, attempts and concurrent replay are enforced by real PostgreSQL', async () => {
    const user = await store.findUserByEmailPassword(newEmail, nextPassword)
    const session = await store.createSession(user)
    const auth = { user, sessionId: session.session.sessionId, method: 'session' }
    const age = () => pool.query("UPDATE email_verification_challenges SET created_at=now()-interval '61 seconds' WHERE purpose='password_reset' AND lower(email)=$1", [newEmail])
    await age(); await service.requestAccountPasswordCode(auth)
    let otp = verificationCodeFromMime(smtp.messages.at(-1).raw)
    await service.verifyAccountPasswordCode(auth, { verificationCode: otp })
    await pool.query("UPDATE email_verification_challenges SET expires_at=now()-interval '1 second' WHERE purpose='password_reset' AND lower(email)=$1", [newEmail])
    await assert.rejects(service.changePassword(auth, { verificationCode: otp, newPassword: 'synthetic-final-password' }), { code: 'INVALID_VERIFICATION_CODE' })
    await age(); await service.requestAccountPasswordCode(auth)
    otp = verificationCodeFromMime(smtp.messages.at(-1).raw)
    for (let i = 0; i < 5; i++) await assert.rejects(service.verifyAccountPasswordCode(auth, { verificationCode: otp === '000000' ? '111111' : '000000' }), { code: 'INVALID_VERIFICATION_CODE' })
    await assert.rejects(service.verifyAccountPasswordCode(auth, { verificationCode: otp }), { code: 'INVALID_VERIFICATION_CODE' })
    await age(); await service.requestAccountPasswordCode(auth)
    otp = verificationCodeFromMime(smtp.messages.at(-1).raw)
    await service.verifyAccountPasswordCode(auth, { verificationCode: otp })
    const results = await Promise.allSettled([1, 2].map(() => service.changePassword(auth, { verificationCode: otp, newPassword: 'synthetic-final-password' })))
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(await store.findSessionByToken(session.token), undefined)
    const next = await store.createSession(user)
    await assert.rejects(service.changePassword({ ...auth, sessionId: next.session.sessionId }, { verificationCode: otp, newPassword: 'another-final-password' }), { code: 'INVALID_VERIFICATION_CODE' })
    assert.deepEqual(await snapshot(userId), before)
  })
  assert.deepEqual(report.pageErrors, [])
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = { message: error.message, stack: error.stack }
  console.error(error)
  process.exitCode = 1
  await page?.screenshot({ path: join(instance.directory, 'failure.png'), fullPage: true }).catch(() => {})
} finally {
  async function clean(name, action) {
    try { await action(); report.cleanup[name] = true }
    catch (error) { report.cleanup[name] = error.message; process.exitCode = 1 }
  }
  await clean('browser', () => browser?.close())
  await clean('frontend', () => vite?.close())
  await clean('api', () => api?.closeAsync())
  await clean('smtp', () => smtp?.close())
  await clean('pool', () => pool?.end())
  if (created) await clean('database', () => admin.query('DROP DATABASE "' + instance.database + '" WITH (FORCE)'))
  await clean('admin', () => admin.end())
  await clean('postgres', () => instance.stop())
  await writeFile(output, JSON.stringify(report, null, 2))
  console.log('Report: ' + output)
}
