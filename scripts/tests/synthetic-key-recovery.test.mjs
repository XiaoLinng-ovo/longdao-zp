import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createSyntheticKeyRecovery } from '../verify-synthetic-key-recovery.mjs'

test('合成配置备份缺密钥或错密钥明确失败，正确密钥可恢复且不能跨公司解密', () => {
  const recovery = createSyntheticKeyRecovery(randomUUID())
  const restored = JSON.parse(JSON.stringify(recovery.fixture))
  assert.deepEqual(recovery.verify(restored), {
    missingKeyRejected: true, wrongKeyRejected: true, crossCompanyRejected: true,
    correctKeyRecovered: true, keyStoredSeparately: true, syntheticOnly: true,
  })
  assert.deepEqual(Object.keys(restored).sort(), ['ciphertext', 'organizationId'])
})

test('损坏或替换的备份不能被当作成功恢复', () => {
  const recovery = createSyntheticKeyRecovery(randomUUID())
  assert.throws(() => recovery.verify({ ...recovery.fixture, ciphertext: 'v1.invalid' }))
  const other = createSyntheticKeyRecovery(randomUUID())
  assert.throws(() => recovery.verify(other.fixture))
})
