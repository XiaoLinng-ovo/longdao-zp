import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDatabaseConfig } from '../src/db/config.js'
import { shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'

// NODE_ENV=test uses an in-memory recruiting store. Spawn a development-mode
// HTTP server so this regression actually traverses the PostgreSQL repository.
test('HTTP entitlement authorization and quota conflicts use real PostgreSQL', { timeout: 100_000 }, t => {
  if (shouldSkipPostgresIntegration()) { t.skip('PostgreSQL not configured'); return }
  const config = loadDatabaseConfig()
  const uri = config.connectionString ? new URL(config.connectionString) : undefined
  const cfg = uri ? {
    host: uri.hostname, port: Number(uri.port || 5432),
    database: decodeURIComponent(uri.pathname.slice(1)),
    user: decodeURIComponent(uri.username), password: decodeURIComponent(uri.password),
  } : { host: config.host, port: config.port, database: config.database, user: config.user, password: config.password }
  // Fail closed rather than ever creating/deleting fixtures in the customer's DB.
  assert.equal(cfg.host, '127.0.0.1')
  assert.match(cfg.database!, /test/i, 'Use a dedicated test database for HTTP quota verification')
  const storage = mkdtempSync(join(tmpdir(), 'smartrecruit-entitlements-http-'))
  const script = fileURLToPath(new URL('../../../../scripts/verify-entitlements-http.mjs', import.meta.url))
  try {
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, ENTITLEMENT_TEST_DATABASE: JSON.stringify(cfg), ENTITLEMENT_TEST_STORAGE: storage },
      encoding: 'utf8', timeout: 95_000, windowsHide: true,
    })
    assert.equal(result.status, 0, `HTTP verification failed: ${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /13 passed \/ 0 failed \/ 0 skipped/)
    t.diagnostic(result.stdout.trim())
  } finally {
    assert.equal(resolve(dirname(storage)), resolve(tmpdir()))
    assert.ok(basename(storage).startsWith('smartrecruit-entitlements-http-'))
    rmSync(storage, { recursive: true, force: true })
  }
})
