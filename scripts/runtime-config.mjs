import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export function parseRuntimeEnv(content) {
  const values = new Map()
  for (const raw of content.split(/\r?\n/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(raw.trim())
    if (!match || values.has(match[1])) continue
    let value = match[2].trim()
    if (/^(["']).*\1$/u.test(value)) value = value.slice(1, -1)
    values.set(match[1], value)
  }
  return Object.fromEntries(values)
}

export function readRuntimeConfig(root, base = process.env) {
  const explicit = base.ENV_FILE_PATH?.trim()
  const source = resolve(explicit || join(root, '.env'))
  // Explicit profiles never fall back to a business .env, including on typo or missing file.
  let values = {}
  for (const file of explicit ? [source] : [source, join(root, 'apps', '.env'), join(root, 'apps', 'api', '.env')]) {
    try { values = { ...values, ...parseRuntimeEnv(readFileSync(file, 'utf8')) } }
    catch (error) { if (explicit || error.code !== 'ENOENT') throw new Error('CONFIG_FILE: Cannot read the selected runtime profile', { cause: error }) }
  }
  const env = { ...values, ...base, ENV_FILE_PATH: source }
  const port = (key, fallback) => {
    const value = Number(env[key]?.trim() || fallback)
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('CONFIG_PORT: Invalid ' + key)
    return value
  }
  const ports = { api: port('PORT', 3100), worker: port('WORKER_HEALTH_PORT', 4001), web: port('WEB_PORT', 5174) }
  if (new Set(Object.values(ports)).size !== 3) throw new Error('CONFIG_PORT: API, Worker and Web ports must be distinct')
  for (const key of ['HOST', 'WORKER_HEALTH_HOST', 'WEB_HOST']) {
    if (env[key]?.trim() && env[key].trim() !== '127.0.0.1') throw new Error('CONFIG_BIND: ' + key + ' must be 127.0.0.1 for local hosting')
  }
  return {
    ports,
    env: { ...env, NODE_ENV: 'production', SMARTRECRUIT_MANAGED_ENV: '1',
      HOST: '127.0.0.1', PORT: String(ports.api), WORKER_HEALTH_HOST: '127.0.0.1', WORKER_HEALTH_PORT: String(ports.worker),
      WEB_HOST: '127.0.0.1', WEB_PORT: String(ports.web), WEB_API_TARGET: 'http://127.0.0.1:' + ports.api },
  }
}

export function validateManagedConfig(env) {
  const errors = []
  for (const key of ['AUTH_OTP_HMAC_SECRET', 'AUTH_MFA_ENCRYPTION_KEY']) {
    if ((env[key]?.trim().length ?? 0) < 32) errors.push('AUTH_CONFIG: Configure the existing production ' + key + ' (32+ characters); do not regenerate keys during startup.')
  }
  if (env.TENANT_SCHEMA_ROUTING !== 'on') errors.push('TENANT_ROUTING: TENANT_SCHEMA_ROUTING must be on. Audit legacy/company data before routing changes.')
  if (env.WORKER_DB_POLL !== 'true') errors.push('WORKER_POLL: Explicitly set WORKER_DB_POLL=true for a full runtime.')
  if (!env.DATABASE_URL?.trim() && !['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER'].every(key => env[key]?.trim())) {
    errors.push('DATABASE_TARGET: Configure DATABASE_URL or all of PGHOST, PGPORT, PGDATABASE, PGUSER.')
  }
  if (!env.S3_ENDPOINT?.trim()) {
    for (const key of ['RECRUITING_QUARANTINE_ROOT', 'INTERVIEW_STORAGE_ROOT']) {
      if (!env[key]?.trim() || !isAbsolute(env[key])) errors.push('OBJECT_STORAGE: Configure the approved absolute ' + key + ' before startup.')
    }
  }
  if (errors.length) throw new Error(errors.join('; '))
}
