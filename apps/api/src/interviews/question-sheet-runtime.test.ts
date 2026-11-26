import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createQuestionSheetAiResolver } from './question-sheet-runtime.js'

describe('面试表前后台共用企业模型配置', () => {
  it('按申请所属企业读取配置，不使用全局或其他企业的密钥', async () => {
    const calls: string[] = []
    const resolver = createQuestionSheetAiResolver({ query: async (sql, values) => {
      assert.match(sql, /j.organization_id = a.organization_id/)
      assert.match(sql, /c.organization_id = a.organization_id/)
      assert.match(sql, /organization_service_available/)
      return { rows: [{ organization_id: values?.[0] === 'app-a' ? 'org-a' : 'org-b' }] }
    } }, { runtimeEnv: async id => { calls.push(id!); return { OPENAI_MODEL: `model-${id}` } } })
    assert.equal((await resolver('app-a')).OPENAI_MODEL, 'model-org-a')
    assert.equal((await resolver('app-b')).OPENAI_MODEL, 'model-org-b')
    assert.deepEqual(calls, ['org-a', 'org-b'])
  })
  it('失效企业或申请不能回落到全局模型', async () => {
    const resolver = createQuestionSheetAiResolver({ query: async () => ({ rows: [] }) }, { runtimeEnv: async () => { throw Error('不应读取配置') } })
    await assert.rejects(resolver('app-missing'), /申请不存在或所属企业当前不可用/)
  })
})
