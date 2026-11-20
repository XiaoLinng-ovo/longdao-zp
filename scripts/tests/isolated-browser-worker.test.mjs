import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { browserWorkerEnvironment } from '../isolated-browser-worker.mjs'
import { isolatedEnvironment } from '../isolated-environment.mjs'

const directory = join('test-root', 'closure_verify_' + 'a'.repeat(32))
const instance = { directory, port: 12345, database: 'closure_verify_' + 'a'.repeat(32), cluster: 'closure_' + 'a'.repeat(32) }
instance.env = isolatedEnvironment({ PGDATABASE: instance.database, ISOLATED_TEST_CLUSTER: instance.cluster,
  RECRUITING_QUARANTINE_ROOT: join(directory, 'storage'), INTERVIEW_STORAGE_ROOT: join(directory, 'interviews'),
  PGPORT: String(instance.port), DB_POOL_MAX: '2', PGCONNECT_TIMEOUT_MS: '1000' }, {})
const runtime = { ...instance.env, OPENAI_BASE_URL: 'http://127.0.0.1:12346/v1', OPENAI_MODEL: 'isolated-synthetic-model', OPENAI_API_KEY: 'synthetic-only' }

test('浏览器后台进程仅继承专用PG和合成模型，不继承邮件支付或代理配置', () => {
  const env = browserWorkerEnvironment(instance, { ...runtime, DATABASE_URL: 'forbidden', SMTP_HOST: 'mail.invalid',
    PAYMENT_ENCRYPTION_KEY: 'forbidden', NODE_OPTIONS: '--inspect', HTTPS_PROXY: 'http://proxy.invalid', OCR_SERVICE_URL: 'https://business.invalid' })
  assert.equal(env.ISOLATED_ALLOWED_PORTS, '12345,12346'); assert.equal(env.SMTP_HOST, '')
  for (const key of ['DATABASE_URL', 'PAYMENT_ENCRYPTION_KEY', 'NODE_OPTIONS', 'HTTPS_PROXY']) assert.equal(env[key], undefined)
  assert.equal(env.PGCONNECT_TIMEOUT_MS, '1000'); assert.equal(env.DB_POOL_MAX, '2')
  assert.equal(env.OCR_SERVICE_URL, undefined)
  assert.equal(env.INTERVIEW_STORAGE_ROOT, join(directory, 'interviews'))
})
test('OCR 只接受显式本机端口，不从业务配置继承', () => {
  const env = browserWorkerEnvironment(instance, runtime, { port: 12347 })
  assert.equal(env.OCR_SERVICE_URL, 'http://127.0.0.1:12347')
  assert.equal(env.ISOLATED_ALLOWED_PORTS, '12345,12346,12347')
  for (const port of [0, -1, 65536, 1.5, '12347', NaN]) assert.throws(() => browserWorkerEnvironment(instance, runtime, { port }))
})
test('拒绝错误库身份、存储目录、外部模型和扩大连接限制', () => {
  for (const changes of [{ PGDATABASE: 'business' }, { ISOLATED_TEST_CLUSTER: 'business' }, { RECRUITING_QUARANTINE_ROOT: 'business' },
    { INTERVIEW_STORAGE_ROOT: undefined }, { INTERVIEW_STORAGE_ROOT: 'business' },
    { OPENAI_BASE_URL: 'https://127.0.0.1:12346/v1' }, { OPENAI_BASE_URL: 'http://example.com:12346/v1' },
    { OPENAI_BASE_URL: 'http://127.0.0.1:12346/v1?key=secret' }, { OPENAI_BASE_URL: 'http://user@127.0.0.1:12346/v1' },
    { OPENAI_BASE_URL: 'http://127.0.0.1/v1' }, { OPENAI_MODEL: 'real-model' }, { OPENAI_API_KEY: '' },
    { DB_POOL_MAX: '20' }, { PGCONNECT_TIMEOUT_MS: '10000' }]) assert.throws(() => browserWorkerEnvironment(instance, { ...runtime, ...changes }))
})
