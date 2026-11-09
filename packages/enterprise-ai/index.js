import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export class EnterpriseAiError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'EnterpriseAiError'; this.code = code; this.status = status }
}
/** Bare origins use OpenAI-compatible /v1. Explicit provider prefixes are preserved.
 * This does not probe or retry another endpoint, and never changes the configured origin. */
export function normalizeAiBaseUrl(value) {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return ''
  validateEnterpriseAiPatch({ OPENAI_BASE_URL: trimmed })
  const url = new URL(trimmed)
  const prefix = url.pathname.replace(/\/+$/u, '')
  url.pathname = prefix || '/v1'
  return url.href.replace(/\/+$/u, '')
}
const keys = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_TIMEOUT_MS']
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
function scope(id) {
  if (typeof id !== 'string' || !uuid.test(id)) throw new EnterpriseAiError('WORKSPACE_REQUIRED', '请先选择有效的企业工作空间', 409)
  return id.toLowerCase()
}
function encryptionKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(value) || Buffer.from(value, 'base64').length !== 32 || Buffer.from(value, 'base64').toString('base64') !== value) {
    throw new EnterpriseAiError('AI_ENCRYPTION_KEY_UNAVAILABLE', '企业 AI 加密主密钥未配置或格式无效，请联系平台管理员', 503)
  }
  return Buffer.from(value, 'base64')
}
// AAD binds ciphertext to an organization; copying a database value between tenants cannot decrypt it.
export function encryptApiKey(secret, organizationId, masterKey) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(masterKey), nonce)
  cipher.setAAD(Buffer.from(`enterprise-ai:v1:${scope(organizationId)}`))
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return ['v1', nonce.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.')
}
export function decryptApiKey(value, organizationId, masterKey) {
  const key = encryptionKey(masterKey)
  try {
    const parts = value.split('.')
    if (parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some(part => Buffer.from(part, 'base64').toString('base64') !== part)) throw new Error('invalid ciphertext')
    const nonce = Buffer.from(parts[1], 'base64'), tag = Buffer.from(parts[2], 'base64')
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('invalid ciphertext')
    const cipher = createDecipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(`enterprise-ai:v1:${scope(organizationId)}`))
    cipher.setAuthTag(tag)
    return Buffer.concat([cipher.update(Buffer.from(parts[3], 'base64')), cipher.final()]).toString('utf8')
  } catch {
    // Never include ciphertext, credentials, or provider responses in this error.
    throw new EnterpriseAiError('AI_SECRET_DECRYPTION_FAILED', '企业 AI 密钥无法解密，请检查平台主密钥备份或重新保存企业密钥', 503)
  }
}
export function validateEnterpriseAiPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new EnterpriseAiError('VALIDATION_ERROR', '模型配置必须是对象')
  for (const [key, value] of Object.entries(patch)) {
    if (!keys.includes(key) || typeof value !== 'string' || /[\r\n]/u.test(value) || value.length > 4000) {
      throw new EnterpriseAiError('VALIDATION_ERROR', '模型配置项无效（仅支持地址、密钥、模型、超时）')
    }
  }
  if (patch.OPENAI_BASE_URL?.trim()) {
    let url
    try { url = new URL(patch.OPENAI_BASE_URL.trim()) } catch { throw new EnterpriseAiError('VALIDATION_ERROR', '接口地址格式无效') }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new EnterpriseAiError('VALIDATION_ERROR', '接口地址仅支持 HTTP/HTTPS，不能包含凭证、查询串或片段')
    }
  }
  if (patch.OPENAI_TIMEOUT_MS !== undefined && (!/^\d+$/u.test(patch.OPENAI_TIMEOUT_MS.trim()) || Number(patch.OPENAI_TIMEOUT_MS) < 1 || Number(patch.OPENAI_TIMEOUT_MS) > 300000)) {
    throw new EnterpriseAiError('VALIDATION_ERROR', '超时必须为 1～300000 毫秒的整数')
  }
}
/** Public SaaS deployments require an operator-managed HTTPS origin allowlist; localhost providers remain usable in development. */
export function assertAiEndpointAllowed(baseUrl, env = process.env) {
  if (!baseUrl) return
  validateEnterpriseAiPatch({OPENAI_BASE_URL: baseUrl})
  const allowed = (env.AI_ALLOWED_BASE_URL_ORIGINS ?? '').split(',').map(item => item.trim()).filter(Boolean)
  if (env.NODE_ENV === 'production' && !allowed.length) throw new EnterpriseAiError('AI_ENDPOINT_POLICY_REQUIRED', '生产环境尚未配置 AI 接口域名白名单，请联系平台管理员', 503)
  const url = new URL(baseUrl)
  if ((env.NODE_ENV === 'production' && url.protocol !== 'https:') || (allowed.length && !allowed.includes(url.origin))) {
    throw new EnterpriseAiError('AI_ENDPOINT_NOT_ALLOWED', '此 AI 接口地址不在平台允许的域名白名单中', 400)
  }
}
function toView(id, row) {
  const env = {
    OPENAI_BASE_URL: {value: row?.base_url ?? '', configured: Boolean(row?.base_url), masked: false},
    // Constant mask avoids exposing key fragments or its length.
    OPENAI_API_KEY: {value: row?.api_key_ciphertext ? '••••••••' : '', configured: Boolean(row?.api_key_ciphertext), masked: true},
    OPENAI_MODEL: {value: row?.model ?? '', configured: Boolean(row?.model), masked: false},
    OPENAI_TIMEOUT_MS: {value: String(row?.timeout_ms ?? 120000), configured: true, masked: false},
  }
  const missing = keys.filter(key => !env[key].configured)
  return { organizationId: id, scope: 'enterprise', configured: missing.length === 0, baseUrlHost: env.OPENAI_BASE_URL.value,
    model: env.OPENAI_MODEL.value, timeoutMs: Number(env.OPENAI_TIMEOUT_MS.value), apiKeyConfigured: env.OPENAI_API_KEY.configured,
    missing, env, updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null }
}
/** Resolve the single platform-managed model configuration used by every enterprise. */
function platformRuntimeEnv(env = process.env) {
  const baseUrl = env.OPENAI_BASE_URL?.trim() ?? ''
  const apiKey = env.OPENAI_API_KEY?.trim() ?? ''
  const model = env.OPENAI_MODEL?.trim() ?? ''
  const timeout = env.OPENAI_TIMEOUT_MS?.trim() || '120000'
  if (!baseUrl || !apiKey || !model || !/^\d+$/u.test(timeout) || Number(timeout) < 1) {
    throw new EnterpriseAiError('PLATFORM_AI_NOT_CONFIGURED', '平台管理员尚未完成 AI 配置，请联系平台管理员', 503)
  }
  assertAiEndpointAllowed(baseUrl, env)
  return {
    OPENAI_BASE_URL: normalizeAiBaseUrl(baseUrl),
    OPENAI_API_KEY: apiKey,
    OPENAI_MODEL: model,
    OPENAI_TIMEOUT_MS: timeout,
  }
}

function enterpriseRuntimeEnv(id, row, masterKey, env = process.env) {
  const baseUrl = row?.base_url?.trim() ?? ''
  const apiKeyCiphertext = row?.api_key_ciphertext ?? ''
  const model = row?.model?.trim() ?? ''
  const timeout = String(row?.timeout_ms ?? 120000)
  if (!baseUrl || !apiKeyCiphertext || !model || !/^\d+$/u.test(timeout) || Number(timeout) < 1) return {}
  const apiKey = decryptApiKey(apiKeyCiphertext, id, masterKey)
  assertAiEndpointAllowed(baseUrl, env)
  return {
    OPENAI_BASE_URL: normalizeAiBaseUrl(baseUrl),
    OPENAI_API_KEY: apiKey,
    OPENAI_MODEL: model,
    OPENAI_TIMEOUT_MS: timeout,
  }
}

/** Resolve the configuration permitted for this enterprise. Platform sharing is explicit. */
export class EnterpriseAiStore {
  constructor(pool, masterKey = process.env.AI_CONFIG_ENCRYPTION_KEY) { this.pool = pool; this.masterKey = masterKey }
  async assertAdmin(organizationId, actorId, executor = this.pool, lock = false) {
    const id = scope(organizationId)
    const result = await executor.query(`SELECT o.id FROM organizations o JOIN organization_members m ON m.organization_id = o.id
      WHERE o.id = $1::uuid AND organization_service_available(o.id) AND m.user_id = $2::uuid AND m.role IN ('owner', 'admin')
      ${lock ? 'FOR UPDATE OF o, m' : ''}`, [id, actorId])
    if (!result.rows[0]) throw new EnterpriseAiError('WORKSPACE_ADMIN_REQUIRED', '只有当前企业所有者或管理员可以管理 AI 配置和 Skill', 403)
    return id
  }
  async get(organizationId) {
    const id = scope(organizationId)
    const result = await this.pool.query('SELECT * FROM enterprise_ai_settings WHERE organization_id = $1::uuid', [id])
    return toView(id, result.rows[0])
  }
  async runtimeEnv(organizationId) {
    const id = scope(organizationId)
    const result = await this.pool.query(`SELECT o.id, o.use_platform_ai, o.platform_ai_source_organization_id,
      own.base_url AS own_base_url, own.api_key_ciphertext AS own_api_key_ciphertext, own.model AS own_model, own.timeout_ms AS own_timeout_ms,
      source.base_url AS source_base_url, source.api_key_ciphertext AS source_api_key_ciphertext, source.model AS source_model, source.timeout_ms AS source_timeout_ms
      FROM organizations o
      LEFT JOIN enterprise_ai_settings own ON own.organization_id = o.id
      LEFT JOIN enterprise_ai_settings source ON source.organization_id = o.platform_ai_source_organization_id
      WHERE o.id = $1::uuid AND o.status = 'active'`, [id])
    if (!result.rows[0]) return {}
    const organization = result.rows[0]
    if (organization.use_platform_ai === true) {
      if (organization.platform_ai_source_organization_id) {
        const sourceId = scope(String(organization.platform_ai_source_organization_id))
        return enterpriseRuntimeEnv(sourceId, {
          base_url: organization.source_base_url,
          api_key_ciphertext: organization.source_api_key_ciphertext,
          model: organization.source_model,
          timeout_ms: organization.source_timeout_ms,
        }, this.masterKey)
      }
      return platformRuntimeEnv()
    }
    return enterpriseRuntimeEnv(id, {
      base_url: organization.own_base_url,
      api_key_ciphertext: organization.own_api_key_ciphertext,
      model: organization.own_model,
      timeout_ms: organization.own_timeout_ms,
    }, this.masterKey)
  }
  async save(organizationId, patch, actorId, requestId) {
    validateEnterpriseAiPatch(patch)
    if (patch.OPENAI_BASE_URL !== undefined) assertAiEndpointAllowed(patch.OPENAI_BASE_URL.trim())
    // Verify key provisioning even when preserving a stored secret; never allow a broken server to overwrite it silently.
    encryptionKey(this.masterKey)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const id = await this.assertAdmin(organizationId, actorId, client, true)
      const current = (await client.query('SELECT * FROM enterprise_ai_settings WHERE organization_id = $1::uuid FOR UPDATE', [id])).rows[0]
      const key = patch.OPENAI_API_KEY === undefined ? current?.api_key_ciphertext ?? null
        : patch.OPENAI_API_KEY.trim() ? encryptApiKey(patch.OPENAI_API_KEY.trim(), id, this.masterKey) : null
      const result = await client.query(`INSERT INTO enterprise_ai_settings (organization_id, base_url, api_key_ciphertext, model, timeout_ms, updated_by)
        VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid) ON CONFLICT (organization_id) DO UPDATE SET
        base_url = excluded.base_url, api_key_ciphertext = excluded.api_key_ciphertext, model = excluded.model,
        timeout_ms = excluded.timeout_ms, updated_by = excluded.updated_by, updated_at = now() RETURNING *`,
        [id, normalizeAiBaseUrl(patch.OPENAI_BASE_URL ?? current?.base_url ?? ''), key, patch.OPENAI_MODEL?.trim() ?? current?.model ?? '',
          patch.OPENAI_TIMEOUT_MS === undefined ? current?.timeout_ms ?? 120000 : Number(patch.OPENAI_TIMEOUT_MS), actorId])
      await client.query(`INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, request_id, metadata)
        VALUES ($1::uuid, $2::uuid, 'enterprise.ai_settings.update', 'enterprise_ai_settings', $1::uuid, $3, $4::jsonb)`,
        [id, actorId, requestId ?? null, JSON.stringify({keys: Object.keys(patch), keyAction: patch.OPENAI_API_KEY === undefined ? 'preserve' : key ? 'replace' : 'clear'})])
      await client.query('COMMIT')
      return toView(id, result.rows[0])
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
}
