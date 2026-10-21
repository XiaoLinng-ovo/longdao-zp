import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Pool } from 'pg'
import { AdminService, AdminValidationError } from '../src/admin/service.js'

const skillId = '00000000-0000-4000-8000-000000000001'
const jobId = '00000000-0000-4000-8000-000000000002'
const actorId = '00000000-0000-4000-8000-000000000003'
const row = { id: skillId, name: '岗位专属评分', target_type: 'resume_score', content: '经验 100 分', is_active: true, created_by: actorId, job_ids: [jobId], created_at: new Date('2026-10-08T00:00:00.000Z'), updated_at: new Date('2026-10-08T00:00:00.000Z') }
function fixture(...responses: Array<Record<string, unknown>[] | Error>) {
  const calls: Array<{ text: string; values: unknown[] }> = []
  let released = false
  const client = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values })
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] }
      const response = responses.shift()
      if (response instanceof Error) throw response
      return { rows: response ?? [] }
    },
    release() { released = true },
  }
  const pool = { query: client.query, connect: async () => client } as unknown as Pool
  return { service: new AdminService(pool), calls, released: () => released }
}
void describe('resume scoring Skill administration', () => {
  it('filters scoring rules separately while preserving document both compatibility', async () => {
    const test = fixture([row], [])
    assert.deepEqual((await test.service.listAiPromptSkills(true, 'resume_score'))[0]?.jobIds, [jobId])
    assert.match(test.calls[0]!.text, /s.is_active = true AND s.target_type = \$1/)
    assert.doesNotMatch(test.calls[0]!.text, /OR s.target_type = 'both'/)
    await test.service.listAiPromptSkills(true, 'jd')
    assert.match(test.calls[1]!.text, /OR s.target_type = 'both'/)
  })
  it('creates the rule, job bindings and audit in one transaction', async () => {
    const test = fixture([{ id: skillId }], [{ id: jobId }], [], [], [], [row], [])
    const result = await test.service.createAiPromptSkill({ name: ' 岗位专属评分 ', content: row.content, targetType: 'resume_score', jobIds: [jobId, jobId.toUpperCase()] }, actorId)
    assert.equal(result.name, row.name)
    const binding = test.calls.find((call) => call.text.startsWith('INSERT INTO ai_resume'))!
    assert.deepEqual(binding.values, [skillId, [jobId]])
    assert.ok(test.calls.some((call) => call.text.includes('INSERT INTO audit_logs')))
    assert.equal(test.calls.at(-1)?.text, 'COMMIT')
    assert.equal(test.released(), true)
  })
  it('rolls back when a job is already assigned rather than overwriting another rule', async () => {
    const test = fixture([{ id: skillId }], [{ id: jobId }], [{ title: '后端', name: '其他规则' }])
    await assert.rejects(test.service.createAiPromptSkill({ name: '新规则', content: row.content, targetType: 'resume_score', jobIds: [jobId] }, actorId), /已绑定评分 Skill/)
    assert.equal(test.calls.at(-1)?.text, 'ROLLBACK')
    assert.ok(!test.calls.some((call) => call.text.startsWith('DELETE FROM ai_resume')))
    assert.equal(test.released(), true)
  })
  it('preserves job bindings when only toggling active status', async () => {
    const test = fixture([], [row], [{ id: jobId }], [], [], [], [], [{ ...row, is_active: false }], [])
    const result = await test.service.updateAiPromptSkill(skillId, { isActive: false }, actorId)
    assert.deepEqual(result.jobIds, [jobId])
    assert.equal(result.isActive, false)
    assert.deepEqual(test.calls.find((call) => call.text.startsWith('INSERT INTO ai_resume'))?.values, [skillId, [jobId]])
    assert.equal(test.calls.at(-1)?.text, 'COMMIT')
  })
  it('rejects invalid job IDs, oversized content and bindings on document Skills', async () => {
    for (const input of [
      { name: '规则', content: '规则', targetType: 'resume_score' as const, jobIds: ['bad-id'] },
      { name: '规则', content: 'a'.repeat(8001), targetType: 'resume_score' as const },
      { name: '规则', content: '规则', targetType: 'both' as const, jobIds: [jobId] },
    ]) {
      const test = fixture()
      await assert.rejects(test.service.createAiPromptSkill(input, actorId), AdminValidationError)
      assert.equal(test.calls.length, 0)
    }
  })
})
