import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { PlatformAiStore, EnterpriseAiStore, encryptApiKey, decryptApiKey } from '../packages/enterprise-ai/index.js'

assert.ok(process.argv[2], 'Explicit isolated PostgreSQL bin directory required')
const instance = await startIsolatedPostgres(process.argv[2])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env, {
  AI_CONFIG_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  OPENAI_BASE_URL: 'https://ignored.example/v1', OPENAI_API_KEY: 'ignored-env-secret', OPENAI_MODEL: 'ignored-model',
})
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
const { Pool } = require('pg'), admin = new Pool(instance.connection)
const actor = randomUUID(), org = randomUUID(), master = process.env.AI_CONFIG_ENCRYPTION_KEY
const secret = 'synthetic-platform-secret', checks = []
let pool, workerPool, created = false
async function check(name, action) { await action(); checks.push(name); console.log('PASS ' + name) }
try {
  assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  await admin.query('CREATE DATABASE "' + instance.database + '"'); created = true
  const connection = { ...instance.connection, database: instance.database }
  pool = new Pool(connection)
  const { runMigrations } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/db/migrations.js')))
  const { AdminService } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/admin/service.js')))
  await runMigrations(pool, join(projectRoot, 'db/migrations'))
  await pool.query("INSERT INTO public.users(id,email,display_name) VALUES($1::uuid,$1::text || '@example.invalid','synthetic')", [actor])
  await pool.query("INSERT INTO public.organizations(id,name,kind,service_status,use_platform_ai,ai_model_source) VALUES($1,'synthetic-platform-ai','test','enabled',true,'platform')", [org])
  const schema = (await pool.query('SELECT public.initialize_organization_schema($1) AS name', [org])).rows[0].name
  workerPool = new Pool({ ...connection, options: '-c search_path=' + schema + ',public' })
  const service = new AdminService(pool, join(instance.directory, 'nonexistent', '.env'))
  const writer = new PlatformAiStore(pool, master), worker = new PlatformAiStore(workerPool, master)
  await check('migration never imports environment credentials or creates company copies', async () => {
    assert.equal((await service.getAiSettings()).configured, false)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.platform_ai_settings')).rows[0].n, 0)
    assert.equal((await pool.query('SELECT to_regclass($1) AS name', [schema + '.platform_ai_settings'])).rows[0].name, null)
    await assert.rejects(worker.runtimeEnv(), { code: 'PLATFORM_AI_NOT_CONFIGURED' })
    await assert.rejects(new EnterpriseAiStore(workerPool, master).runtimeEnv(org), { code: 'PLATFORM_AI_NOT_CONFIGURED' })
  })
  await check('admin save encrypts secrets and worker immediately uses persisted platform settings', async () => {
    const view = await service.updateAiSettings({ OPENAI_BASE_URL: 'https://provider.example', OPENAI_API_KEY: secret, OPENAI_MODEL: 'model-a', OPENAI_TIMEOUT_MS: '25000' }, actor, 'synthetic-save')
    assert.equal(view.configured, true)
    assert.equal(view.env.OPENAI_API_KEY.value, '••••••••')
    assert.ok(!JSON.stringify(view).includes(secret))
    const row = (await pool.query('SELECT * FROM public.platform_ai_settings')).rows[0]
    assert.ok(!JSON.stringify(row).includes(secret))
    const audit = (await pool.query("SELECT * FROM public.platform_audit_logs WHERE action='admin.ai_settings.update'")).rows
    assert.equal(audit.length, 1)
    assert.ok(!JSON.stringify(audit).includes(secret))
    assert.ok(!JSON.stringify(audit).includes(row.api_key_ciphertext))
    assert.equal((await worker.runtimeEnv()).OPENAI_API_KEY, secret)
    assert.equal((await new EnterpriseAiStore(workerPool, master).runtimeEnv(org)).OPENAI_MODEL, 'model-a')
    await assert.rejects(pool.query('INSERT INTO public.platform_ai_settings(singleton) VALUES(false)'), { code: '23514' })
  })
  await check('connection testing uses database credentials or explicit drafts without environment fallback', async () => {
    const original = globalThis.fetch
    try {
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'https://provider.example/v1/models')
        assert.equal(init.headers.Authorization, 'Bearer ' + secret)
        assert.equal(init.redirect, 'error')
        return new Response('{"data":[{"id":"model-a"}]}')
      }
      assert.equal((await service.testAiConnection()).ok, true)
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'https://draft.example/v1/models')
        assert.equal(init.headers.Authorization, 'Bearer draft-secret')
        return new Response('{"data":[]}')
      }
      assert.equal((await service.testAiConnection({ baseUrl: 'https://draft.example', apiKey: 'draft-secret' })).ok, true)
      assert.equal((await worker.runtimeEnv()).OPENAI_API_KEY, secret)
    } finally { globalThis.fetch = original }
  })
  await check('concurrent partial saves preserve key and each others fields across separate pools', async () => {
    const ciphertext = (await pool.query('SELECT api_key_ciphertext FROM public.platform_ai_settings')).rows[0].api_key_ciphertext
    await Promise.all([writer.save({ OPENAI_MODEL: 'model-b' }, actor), worker.save({ OPENAI_TIMEOUT_MS: '27000' }, actor)])
    const env = await new PlatformAiStore(workerPool, master).runtimeEnv()
    assert.equal(env.OPENAI_MODEL, 'model-b'); assert.equal(env.OPENAI_TIMEOUT_MS, '27000')
    assert.equal((await pool.query('SELECT api_key_ciphertext FROM public.platform_ai_settings')).rows[0].api_key_ciphertext, ciphertext)
  })
  await check('audit failure rolls back the configuration update', async () => {
    await pool.query(`CREATE FUNCTION public.reject_synthetic_ai_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
      CREATE TRIGGER reject_synthetic_ai_audit BEFORE INSERT ON public.platform_audit_logs FOR EACH ROW EXECUTE FUNCTION public.reject_synthetic_ai_audit()`)
    try { await assert.rejects(writer.save({ OPENAI_MODEL: 'must-rollback' }, actor), /synthetic audit failure/) }
    finally { await pool.query('DROP TRIGGER reject_synthetic_ai_audit ON public.platform_audit_logs; DROP FUNCTION public.reject_synthetic_ai_audit()') }
    assert.equal((await worker.runtimeEnv()).OPENAI_MODEL, 'model-b')
  })
  await check('platform ciphertext cannot be transplanted into enterprise scope or read with another master', async () => {
    const ciphertext = (await pool.query('SELECT api_key_ciphertext FROM public.platform_ai_settings')).rows[0].api_key_ciphertext
    assert.throws(() => decryptApiKey(ciphertext, org, master), { code: 'AI_SECRET_DECRYPTION_FAILED' })
    await assert.rejects(new PlatformAiStore(workerPool, randomBytes(32).toString('base64')).runtimeEnv(), { code: 'AI_SECRET_DECRYPTION_FAILED' })
    await assert.rejects(new PlatformAiStore(workerPool, '').save({ OPENAI_MODEL: 'bad' }, actor), { code: 'AI_ENCRYPTION_KEY_UNAVAILABLE' })
    await pool.query('UPDATE public.platform_ai_settings SET api_key_ciphertext=$1', [encryptApiKey(secret, org, master)])
    await assert.rejects(worker.runtimeEnv(), { code: 'AI_SECRET_DECRYPTION_FAILED' })
    await writer.save({ OPENAI_API_KEY: secret }, actor)
  })
  await check('clearing credentials fails closed despite legacy environment values; deletion also never falls back', async () => {
    await service.updateAiSettings({ OPENAI_API_KEY: '' }, actor)
    assert.equal((await service.getAiSettings()).apiKeyConfigured, false)
    await assert.rejects(worker.runtimeEnv(), { code: 'PLATFORM_AI_NOT_CONFIGURED' })
    assert.equal((await service.testAiConnection()).ok, false)
    await pool.query('DELETE FROM public.platform_ai_settings')
    await assert.rejects(worker.runtimeEnv(), { code: 'PLATFORM_AI_NOT_CONFIGURED' })
    await writer.save({ OPENAI_MODEL: 'only-model' }, actor)
    assert.equal((await writer.get()).env.OPENAI_BASE_URL.value, '')
    assert.equal((await writer.get()).apiKeyConfigured, false)
    await assert.rejects(worker.runtimeEnv(), { code: 'PLATFORM_AI_NOT_CONFIGURED' })
  })
  await check('concurrent initial saves merge without borrowing environment values', async () => {
    await pool.query('DELETE FROM public.platform_ai_settings')
    await Promise.all([
      writer.save({ OPENAI_BASE_URL: 'https://provider.example', OPENAI_TIMEOUT_MS: '28000' }, actor),
      worker.save({ OPENAI_API_KEY: secret, OPENAI_MODEL: 'first-insert-model' }, actor),
    ])
    assert.equal((await worker.runtimeEnv()).OPENAI_MODEL, 'first-insert-model')
    assert.equal((await worker.runtimeEnv()).OPENAI_API_KEY, secret)
    assert.equal((await worker.runtimeEnv()).OPENAI_TIMEOUT_MS, '28000')
  })
  await check('production endpoint policy applies to database runtime, saves and connection tests', async () => {
    const previous = { NODE_ENV: process.env.NODE_ENV, AI_ALLOWED_BASE_URL_ORIGINS: process.env.AI_ALLOWED_BASE_URL_ORIGINS }
    process.env.NODE_ENV = 'production'
    delete process.env.AI_ALLOWED_BASE_URL_ORIGINS
    try {
      await assert.rejects(worker.runtimeEnv(), { code: 'AI_ENDPOINT_POLICY_REQUIRED' })
      process.env.AI_ALLOWED_BASE_URL_ORIGINS = 'https://provider.example'
      assert.equal((await worker.runtimeEnv()).OPENAI_MODEL, 'first-insert-model')
      await assert.rejects(writer.save({ OPENAI_BASE_URL: 'https://attacker.invalid' }, actor), { code: 'AI_ENDPOINT_NOT_ALLOWED' })
      await assert.rejects(service.testAiConnection({ baseUrl: 'https://attacker.invalid', apiKey: 'draft' }), { code: 'AI_ENDPOINT_NOT_ALLOWED' })
      assert.equal((await worker.runtimeEnv()).OPENAI_BASE_URL, 'https://provider.example/v1')
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, isolated: true }))
} finally {
  await workerPool?.end(); await pool?.end()
  if (created) await admin.query('DROP DATABASE "' + instance.database + '" WITH (FORCE)')
  await admin.end(); await instance.stop()
}
