import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { encryptApiKey, decryptApiKey } from '../packages/enterprise-ai/index.js'

// Only synthetic credentials; the recovery key stays in memory, outside the database/file backup.
export function createSyntheticKeyRecovery(organizationId) {
  const key = randomBytes(32).toString('base64')
  const secret = 'synthetic-restore-' + randomUUID()
  const fixture = { organizationId, ciphertext: encryptApiKey(secret, organizationId, key) }
  return {
    fixture,
    verify(restored) {
      assert.equal(restored.organizationId, organizationId)
      assert.throws(() => decryptApiKey(restored.ciphertext, organizationId, undefined), { code: 'AI_ENCRYPTION_KEY_UNAVAILABLE', status: 503 })
      assert.throws(() => decryptApiKey(restored.ciphertext, organizationId, randomBytes(32).toString('base64')), { code: 'AI_SECRET_DECRYPTION_FAILED', status: 503 })
      assert.throws(() => decryptApiKey(restored.ciphertext, randomUUID(), key), { code: 'AI_SECRET_DECRYPTION_FAILED', status: 503 })
      assert.ok(decryptApiKey(restored.ciphertext, organizationId, key) === secret, '合成配置密钥恢复失败')
      const serialized = JSON.stringify(restored)
      assert.ok(!serialized.includes(key) && !serialized.includes(secret), '备份不得包含主密钥或明文凭据')
      return { missingKeyRejected: true, wrongKeyRejected: true, crossCompanyRejected: true, correctKeyRecovered: true, keyStoredSeparately: true, syntheticOnly: true }
    },
  }
}
