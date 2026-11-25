import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { PlatformAiStore, EnterpriseAiStore, encryptApiKey, decryptApiKey, validateEnterpriseAiPatch, validateSelfServiceAiPatch, SELF_SERVICE_AI_BASE_URL, assertAiEndpointAllowed } from './index.js'
let platformRow
const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const key = randomBytes(32).toString('base64'), secret = 'tenant-only-test-secret'
const code = expected => error => error.code === expected && !error.message.includes(secret)
async function withPlatformEnv(values, action) {
  const keys = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_TIMEOUT_MS']
  const previous = Object.fromEntries(keys.map(item => [item, process.env[item]]))
  for (const item of keys) delete process.env[item]
  Object.assign(process.env, values)
  try { return await action() } finally {
    for (const item of keys) {
      if (previous[item] === undefined) delete process.env[item]
      else process.env[item] = previous[item]
    }
  }
}

// Produce platform-scoped ciphertext through the real writer, never enterprise AAD.
await new PlatformAiStore({connect:async()=>({release(){},query:async(sql,values)=>{
  if (sql.includes('INSERT INTO public.platform_ai_settings')) {
    platformRow={base_url:values[0],api_key_ciphertext:values[1],model:values[2],timeout_ms:values[3]}
    return {rows:[platformRow]}
  }
  return {rows:[]}
}})},key).save({OPENAI_BASE_URL:'https://platform.example/v1',OPENAI_API_KEY:'platform-secret',OPENAI_MODEL:'platform-model',OPENAI_TIMEOUT_MS:'2000'},b)

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
function fakePool(admin = true, source = 'enterprise') {
  let row, audit, rolledBack = false
  const query = async (sql, values = []) => {
    if (sql === 'ROLLBACK') rolledBack = true
    if (sql.includes('JOIN organization_members')) return {rows: admin ? [{id:values[0]}] : []}
    if (sql.includes('FROM public.organizations')) return {rows: [{use_platform_ai: true, ai_model_source: source}]}
    if (sql.includes('FROM organizations')) return {rows: [{id: values[0], ai_model_source: source, use_platform_ai: true, platform_ai_source_organization_id: null,
      own_self_service_enabled: row?.self_service_enabled, own_base_url: row?.base_url, own_api_key_ciphertext: row?.api_key_ciphertext, own_model: row?.model}]}
    if (sql.includes('public.platform_ai_settings')) return {rows: platformRow ? [platformRow] : []}
    if (sql.startsWith('SELECT')) return {rows: row ? [row] : []}
    if (sql.includes('INSERT INTO enterprise_ai_settings')) { row = {organization_id:values[0],base_url:values[1],api_key_ciphertext:values[2],model:values[3],timeout_ms:values[4],self_service_enabled:values[6]}; return {rows:[row]} }
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
test('explicitly authorized platform-source enterprises share platform configuration', async () => {
  await withPlatformEnv({OPENAI_BASE_URL:'https://platform.example/v1',OPENAI_API_KEY:'platform-secret',OPENAI_MODEL:'platform-model',OPENAI_TIMEOUT_MS:'2000'}, async () => {
    const store = new EnterpriseAiStore({query:async (sql, values) => {
      if (sql.includes('public.platform_ai_settings')) return {rows: [platformRow]}
      assert.match(sql, /FROM organizations/u)
      return {rows:[{id: values[0], ai_model_source: 'platform', use_platform_ai: true, platform_ai_source_organization_id: null}]}
    }},key)
    const first = await store.runtimeEnv(a)
    const second = await store.runtimeEnv(b)
    assert.deepEqual(first, second)
    assert.equal(first.OPENAI_MODEL, 'platform-model')
    assert.equal(first.OPENAI_API_KEY, 'platform-secret')
  })
})
test('an active enterprise without platform configuration fails explicitly', async () => {
  await withPlatformEnv({OPENAI_BASE_URL:'https://ignored.example/v1',OPENAI_API_KEY:'ignored-key',OPENAI_MODEL:'ignored-model'}, async () => {
    const store = new EnterpriseAiStore({query:async(sql)=>({rows:sql.includes('public.platform_ai_settings') ? [] : [{id:a, ai_model_source: 'platform', use_platform_ai: true, platform_ai_source_organization_id: null}]})},key)
    await assert.rejects(store.runtimeEnv(a),code('PLATFORM_AI_NOT_CONFIGURED'))
  })
})
test('an inactive or unknown enterprise cannot resolve platform configuration', async () => {
  await withPlatformEnv({OPENAI_BASE_URL:'https://platform.example/v1',OPENAI_API_KEY:'platform-secret',OPENAI_MODEL:'platform-model'}, async () => {
    const store = new EnterpriseAiStore({query:async()=>({rows:[]})},key)
    await assert.rejects(store.runtimeEnv(a), code('WORKSPACE_REQUIRED'))
  })
})
test('save masks the key; omitted preserves, explicit empty clears; audit contains no secret', async () => {
  const pool = fakePool(), store = new EnterpriseAiStore(pool,key)
  const view = await store.save(a,{OPENAI_BASE_URL:'https://provider.example/v1',OPENAI_MODEL:'model-a',OPENAI_API_KEY:secret},b,'request-test')
  assert.equal(view.env.OPENAI_API_KEY.value,'••••••••'); assert.ok(!JSON.stringify(view).includes(secret))
  const ciphertext = pool.row.api_key_ciphertext
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

test('self-service rejects endpoint, timeout, tenant injection and malformed fields', async () => {
  const store = new EnterpriseAiStore(fakePool(), key)
  for (const patch of [null, [], { OPENAI_BASE_URL: SELF_SERVICE_AI_BASE_URL }, { baseUrl: 'https://attacker.invalid' },
    { OPENAI_TIMEOUT_MS: '5000' }, { organizationId: b }, { OPENAI_MODEL: '' }, { OPENAI_API_KEY: 123 }]) {
    assert.throws(() => validateSelfServiceAiPatch(patch), code('VALIDATION_ERROR'))
    await assert.rejects(store.saveSelfService(a, patch, b), code('VALIDATION_ERROR'))
  }
  validateSelfServiceAiPatch({ OPENAI_API_KEY: secret, OPENAI_MODEL: 'tenant-model' })
})

test('self-service persists encrypted keys, forces endpoint and takes precedence over platform defaults', async () => {
  await withPlatformEnv({ OPENAI_BASE_URL: 'https://platform.example/v1', OPENAI_API_KEY: 'platform-key', OPENAI_MODEL: 'platform-model' }, async () => {
    const pool = fakePool(), store = new EnterpriseAiStore(pool, key)
    const view = await store.saveSelfService(a, { OPENAI_API_KEY: secret, OPENAI_MODEL: 'tenant-model' }, b)
    assert.equal(view.env.OPENAI_BASE_URL.value, SELF_SERVICE_AI_BASE_URL)
    assert.equal(view.apiKeyConfigured, true)
    assert.ok(!JSON.stringify(view).includes(secret))
    assert.ok(!JSON.stringify(pool.audit).includes(secret))
    const ciphertext = pool.row.api_key_ciphertext
    await store.saveSelfService(a, { OPENAI_MODEL: 'tenant-model-2' }, b)
    assert.equal(pool.row.api_key_ciphertext, ciphertext)
    pool.row.base_url = 'https://attacker.invalid'
    pool.row.timeout_ms = 1
    const env = await store.runtimeEnv(a)
    assert.equal(env.OPENAI_BASE_URL, SELF_SERVICE_AI_BASE_URL + '/v1')
    assert.equal(env.OPENAI_API_KEY, secret)
    assert.equal(env.OPENAI_MODEL, 'tenant-model-2')
    assert.equal(env.OPENAI_TIMEOUT_MS, '120000')
    const connection = await store.selfServiceConnectionEnv(a)
    assert.equal(connection.OPENAI_API_KEY, secret)
    assert.equal(connection.OPENAI_BASE_URL, SELF_SERVICE_AI_BASE_URL + '/v1')
    await store.saveSelfService(a, { OPENAI_API_KEY: '' }, b)
    assert.equal((await store.getSelfService(a)).apiKeyConfigured, false)
    await assert.rejects(store.runtimeEnv(a), code('ENTERPRISE_AI_NOT_CONFIGURED'))
    assert.equal((await store.selfServiceConnectionEnv(a)).OPENAI_API_KEY, '')
  })
})

test('historical credentials are not exposed or silently enabled by self-service', async () => {
  const pool = fakePool(), store = new EnterpriseAiStore(pool, key)
  await store.save(a, { OPENAI_BASE_URL: 'https://old.example', OPENAI_API_KEY: secret, OPENAI_MODEL: 'old-model' }, b)
  const view = await store.getSelfService(a)
  assert.equal(view.apiKeyConfigured, false)
  assert.equal(view.model, '')
  assert.equal(view.env.OPENAI_BASE_URL.value, SELF_SERVICE_AI_BASE_URL)
  assert.equal((await store.selfServiceConnectionEnv(a)).OPENAI_API_KEY, '')
  await assert.rejects(store.saveSelfService(a, { OPENAI_MODEL: 'new-model' }, b), code('VALIDATION_ERROR'))
})

test('self-service requires a valid workspace membership and fails closed for incomplete config', async () => {
  const pool = fakePool(false), store = new EnterpriseAiStore(pool, key)
  await assert.rejects(store.saveSelfService(a, { OPENAI_API_KEY: secret, OPENAI_MODEL: 'model' }, b), code('WORKSPACE_ADMIN_REQUIRED'))
  assert.equal(pool.rolledBack, true)
  const valid = new EnterpriseAiStore(fakePool(), key)
  await assert.rejects(valid.saveSelfService(undefined, { OPENAI_API_KEY: secret, OPENAI_MODEL: 'model' }, b), code('WORKSPACE_REQUIRED'))
  await assert.rejects(valid.saveSelfService(a, { OPENAI_API_KEY: secret }, b), code('VALIDATION_ERROR'))
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
test('enterprise save remains backward-compatible but cannot override platform runtime settings when sharing is enabled', async () => {
  await withPlatformEnv({OPENAI_BASE_URL:'https://platform.example/v1',OPENAI_API_KEY:'platform-secret',OPENAI_MODEL:'platform-model'}, async () => {
    const pool = fakePool(true, 'platform'), store = new EnterpriseAiStore(pool, key)
    const view = await store.save(a, {OPENAI_BASE_URL:'https://provider.example',OPENAI_MODEL:'tenant-model',OPENAI_API_KEY:secret}, b)
    assert.equal(view.env.OPENAI_BASE_URL.value, 'https://provider.example/v1')
    assert.equal((await store.runtimeEnv(a)).OPENAI_BASE_URL, 'https://platform.example/v1')
    assert.equal((await store.runtimeEnv(a)).OPENAI_MODEL, 'platform-model')
    assert.equal((await store.runtimeEnv(a)).OPENAI_API_KEY, 'platform-secret')
  })
})
