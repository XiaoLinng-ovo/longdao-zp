import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { EnterpriseAiStore, encryptApiKey, decryptApiKey, validateEnterpriseAiPatch, assertAiEndpointAllowed } from './index.js'
const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const key = randomBytes(32).toString('base64'), secret = 'tenant-only-test-secret'
const code = expected => error => error.code === expected && !error.message.includes(secret)

test('AES-GCM uses randomized ciphertext and roundtrips without storing plaintext', () => {
  const first = encryptApiKey(secret, a, key), second = encryptApiKey(secret, a, key)
  assert.notEqual(first, second); assert.ok(!first.includes(secret)); assert.equal(decryptApiKey(first, a, key), secret)
})
test('tenant-bound AAD rejects cross-tenant copies, tampering and wrong master keys safely', () => {
  const encrypted = encryptApiKey(secret, a, key)
  for (const [value, org, master] of [[encrypted,b,key], [encrypted,a,randomBytes(32).toString('base64')], [encrypted+'x',a,key], ['bad',a,key]]) {
    assert.throws(() => decryptApiKey(value,org,master),code('AI_SECRET_DECRYPTION_FAILED'))
  }
})
test('invalid or missing master keys fail closed', () => {
  for (const master of [undefined, '', '123', randomBytes(16).toString('base64')]) assert.throws(() => encryptApiKey(secret,a,master),code('AI_ENCRYPTION_KEY_UNAVAILABLE'))
})
test('patch validation rejects unknown fields, credentials in URLs, newline injection and invalid timeouts', () => {
  for (const patch of [null, [], {token:'x'}, {OPENAI_API_KEY:'a\nb'}, {OPENAI_MODEL:4}, {OPENAI_BASE_URL:'ftp://a'}, {OPENAI_BASE_URL:'https://user:pass@a/v1'}, {OPENAI_BASE_URL:'https://a/v1?key=x'}, {OPENAI_TIMEOUT_MS:'0'}, {OPENAI_TIMEOUT_MS:'300001'}, {OPENAI_TIMEOUT_MS:'1.5'}]) assert.throws(() => validateEnterpriseAiPatch(patch),code('VALIDATION_ERROR'))
  validateEnterpriseAiPatch({OPENAI_BASE_URL:'http://127.0.0.1:1234/v1',OPENAI_TIMEOUT_MS:'300000',OPENAI_API_KEY:''})
})
test('production requires platform-managed HTTPS exact-origin allowlist', () => {
  assert.throws(() => assertAiEndpointAllowed('https://allowed.example/v1',{NODE_ENV:'production'}),code('AI_ENDPOINT_POLICY_REQUIRED'))
  const env = {NODE_ENV:'production',AI_ALLOWED_BASE_URL_ORIGINS:'https://allowed.example'}
  assertAiEndpointAllowed('https://allowed.example/v1',env)
  for (const url of ['http://allowed.example/v1','https://allowed.example.attacker.test/v1','https://allowed.example:444/v1']) assert.throws(() => assertAiEndpointAllowed(url,env),code('AI_ENDPOINT_NOT_ALLOWED'))
  assertAiEndpointAllowed('http://127.0.0.1:1234/v1',{NODE_ENV:'development'})
})
function fakePool(admin = true) {
  let row, audit, rolledBack = false
  const query = async (sql, values = []) => {
    if (sql === 'ROLLBACK') rolledBack = true
    if (sql.includes('JOIN organization_members')) return {rows: admin ? [{id:values[0]}] : []}
    if (sql.startsWith('SELECT')) return {rows: row ? [row] : []}
    if (sql.includes('INSERT INTO enterprise_ai_settings')) { row = {organization_id:values[0],base_url:values[1],api_key_ciphertext:values[2],model:values[3],timeout_ms:values[4]}; return {rows:[row]} }
    if (sql.includes('INSERT INTO audit_logs')) audit = values
    return {rows:[]}
  }
  return {query,connect:async()=>({query,release(){}}),get row(){return row},get audit(){return audit},get rolledBack(){return rolledBack}}
}
test('missing tenant context is rejected instead of selecting global configuration', async () => {
  const store = new EnterpriseAiStore(fakePool(),key)
  await assert.rejects(store.get(undefined),code('WORKSPACE_REQUIRED'))
  await assert.rejects(store.runtimeEnv('bad'),code('WORKSPACE_REQUIRED'))
})
test('no enterprise record means empty configuration even if global credentials exist', async () => {
  const prior = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = secret
  try { assert.deepEqual(await new EnterpriseAiStore(fakePool(),key).runtimeEnv(a),{}) }
  finally { if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior }
})
test('save masks the key; omitted preserves, explicit empty clears; audit contains no secret', async () => {
  const pool = fakePool(), store = new EnterpriseAiStore(pool,key)
  const view = await store.save(a,{OPENAI_BASE_URL:'https://provider.example/v1',OPENAI_MODEL:'model-a',OPENAI_API_KEY:secret},b,'request-test')
  assert.equal(view.env.OPENAI_API_KEY.value,'••••••••'); assert.ok(!JSON.stringify(view).includes(secret))
  const ciphertext = pool.row.api_key_ciphertext
  assert.equal((await store.runtimeEnv(a)).OPENAI_API_KEY,secret)
  await store.save(a,{OPENAI_MODEL:'model-b'},b)
  assert.equal(pool.row.api_key_ciphertext,ciphertext); assert.equal(JSON.parse(pool.audit[3]).keyAction,'preserve')
  assert.ok(!JSON.stringify(pool.audit).includes(secret)); assert.ok(!JSON.stringify(pool.audit).includes(ciphertext))
  await store.save(a,{OPENAI_API_KEY:''},b)
  assert.equal(pool.row.api_key_ciphertext,null); assert.equal((await store.get(a)).apiKeyConfigured,false)
  assert.equal(JSON.parse(pool.audit[3]).keyAction,'clear')
})
test('non-admin cannot write and transaction rolls back', async () => {
  const pool = fakePool(false), store = new EnterpriseAiStore(pool,key)
  await assert.rejects(store.save(a,{OPENAI_MODEL:'x'},b),code('WORKSPACE_ADMIN_REQUIRED'))
  assert.equal(pool.row,undefined); assert.equal(pool.rolledBack,true)
})


test('bare origins normalize to /v1 while explicit provider prefixes remain unchanged', async () => {
  const { normalizeAiBaseUrl } = await import('./index.js')
  assert.equal(normalizeAiBaseUrl(' https://provider.example/ '), 'https://provider.example/v1')
  assert.equal(normalizeAiBaseUrl('https://provider.example/v1///'), 'https://provider.example/v1')
  assert.equal(normalizeAiBaseUrl('https://provider.example/custom/api/'), 'https://provider.example/custom/api')
  assert.equal(normalizeAiBaseUrl(''), '')
  assert.throws(() => normalizeAiBaseUrl('https://user:password@provider.example/'), code('VALIDATION_ERROR'))
  assert.throws(() => normalizeAiBaseUrl('https://provider.example/?token=secret'), code('VALIDATION_ERROR'))
})
test('saving a bare origin normalizes its path, preserves the tenant secret and never writes global env', async () => {
  const prior = process.env.OPENAI_BASE_URL
  const pool = fakePool(), store = new EnterpriseAiStore(pool, key)
  const view = await store.save(a, {OPENAI_BASE_URL:'https://provider.example',OPENAI_MODEL:'model',OPENAI_API_KEY:secret}, b)
  assert.equal(view.env.OPENAI_BASE_URL.value, 'https://provider.example/v1')
  assert.equal((await store.runtimeEnv(a)).OPENAI_BASE_URL, 'https://provider.example/v1')
  assert.equal((await store.runtimeEnv(a)).OPENAI_API_KEY, secret)
  assert.equal(process.env.OPENAI_BASE_URL, prior)
})
test('legacy root URL works at runtime without mutating its stored row', async () => {
  const row = {base_url:'https://provider.example',api_key_ciphertext:encryptApiKey(secret,a,key),model:'model',timeout_ms:2000}
  const store = new EnterpriseAiStore({query:async()=>({rows:[row]})},key)
  assert.equal((await store.runtimeEnv(a)).OPENAI_BASE_URL, 'https://provider.example/v1')
  assert.equal(row.base_url, 'https://provider.example')
})
