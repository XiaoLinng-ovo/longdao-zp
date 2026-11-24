import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { ObjectStorage } from '@smartrecruit-pro/object-storage'
import { AdminService } from '../src/admin/service.js'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository } from '../src/recruiting/repositories/postgres-repository.js'
import { RecruitingService } from '../src/recruiting/service.js'
import { resumeScoreSummary } from '../src/recruiting/resume-scoring.js'

test('PostgreSQL scoring Skills bind by job, reject conflicts and preserve historical rules', async (context) => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool()
  const organizationId = randomUUID(), actorId = randomUUID(), jobId = randomUUID(), otherJobId = randomUUID(), unboundJobId = randomUUID()
  const admin = new AdminService(pool).forOrganization(organizationId)
  const repository = new NormalizedRecruitingRepository(pool, { organizationId })
  const skillIds: string[] = []
  const objects = new Map<string, Buffer>()
  const storage: ObjectStorage = {
    kind: 'local',
    async put(key, body) { objects.set(key, Buffer.from(body)) },
    async get(key) { const body = objects.get(key); if (!body) throw new Error('missing fixture'); return body },
    async delete(key) { objects.delete(key) }, async health() { return true },
  }
  const service = new RecruitingService(undefined, undefined, storage, repository)
  let candidateId: string | undefined
  try {
    await pool.query("INSERT INTO organizations (id, name, kind) VALUES ($1, 'scoring-skills-integration-test', 'test')", [organizationId])
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, '评分规则测试管理员')", [actorId, `${actorId}@example.invalid`])
    await pool.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [organizationId, actorId])
    for (const id of [jobId, otherJobId, unboundJobId]) {
      await pool.query("INSERT INTO jobs (id, organization_id, job_no, title, headcount) VALUES ($1, $2, $3, '评分规则测试岗位', 1)", [id, organizationId, `JOB-${id}`])
    }
    const skill = await admin.createAiPromptSkill({ name: '测试：项目优先', content: '项目经验 80 分，技能 20 分；逐项提供证据。', targetType: 'resume_score', jobIds: [jobId, otherJobId] }, actorId)
    skillIds.push(skill.id)
    assert.deepEqual(skill.jobIds, [jobId, otherJobId].sort())
    assert.equal(await repository.hasActiveResumeScoringSkill(jobId), true)
    assert.equal(await repository.hasActiveResumeScoringSkill(unboundJobId), false)
    const snapshot = { id: skill.id, name: skill.name, content: skill.content, updatedAt: skill.updatedAt }
    const historicalResult = { analysis: { report: { assessment: { score: 82 }, provenance: { scoringSkill: snapshot } }, suggestion: { summary: '项目 64 + 技能 18 = 82 分' } } }
    await assert.rejects(admin.createAiPromptSkill({ name: '冲突测试规则', content: '经验 100 分', targetType: 'resume_score', jobIds: [jobId] }, actorId), /岗位已绑定其他评分 Skill/)
    assert.equal((await pool.query('SELECT id FROM ai_prompt_skills WHERE created_by = $1', [actorId])).rows.length, 1, 'conflicting create rolls back its Skill row')
    const candidate = await repository.createCandidate({ name: '规则测试候选人' }); candidateId = candidate.id
    const applicationId = randomUUID()
    await pool.query('INSERT INTO applications (id, organization_id, application_no, candidate_id, job_id) VALUES ($1, $2, $3, $4, $5)', [applicationId, organizationId, `APP-${applicationId}`, candidate.id, jobId])
    const created = await service.createResume({ candidateId: candidate.id, applicationId, originalFilename: 'skill-test.txt', mimeType: 'text/plain', content: '规则测试候选人，有项目开发经验。' })
    await pool.query("UPDATE analysis_tasks SET available_at = '2099-01-01' WHERE id = $1", [created.task.id])
    await pool.query("UPDATE resumes SET scan_status = 'clean' WHERE id = $1", [created.resume.id])
    await assert.rejects(service.processAnalysisTask(created.task.id), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SCORING_SKILL_WORKER_REQUIRED')
    assert.equal((await repository.getAnalysisTask(created.task.id)).status, 'queued', 'inline analysis must leave the task for the AI Worker')
    const disabled = await admin.updateAiPromptSkill(skill.id, { isActive: false }, actorId)
    assert.deepEqual(disabled.jobIds, skill.jobIds)
    assert.equal(await repository.hasActiveResumeScoringSkill(jobId), false)
    await admin.updateAiPromptSkill(skill.id, { isActive: true, content: '技能 100 分' }, actorId)
    assert.equal(await repository.hasActiveResumeScoringSkill(jobId), true)
    assert.deepEqual(resumeScoreSummary('historical', historicalResult).scoringSkill, snapshot)
    assert.equal(resumeScoreSummary('historical', historicalResult).scoringExplanation, '项目 64 + 技能 18 = 82 分')
    await admin.updateAiPromptSkill(skill.id, { jobIds: [otherJobId] }, actorId)
    const replacement = await admin.createAiPromptSkill({ name: '测试：技能优先', content: '技能 100 分', targetType: 'resume_score', jobIds: [jobId] }, actorId)
    skillIds.push(replacement.id)
    await admin.deleteAiPromptSkill(replacement.id, actorId)
    assert.equal(await repository.hasActiveResumeScoringSkill(jobId), false, 'deleting a Skill cascades only its bindings')
    assert.equal(await repository.hasActiveResumeScoringSkill(otherJobId), true)
    assert.ok((await pool.query("SELECT id FROM audit_logs WHERE actor_user_id = $1 AND action LIKE 'admin.ai_prompt_skill.%'", [actorId])).rows.length >= 6)
  } finally {
    await pool.query('DELETE FROM ai_prompt_skills WHERE created_by = $1 OR id = ANY($2::uuid[])', [actorId, skillIds])
    await pool.query('DELETE FROM audit_logs WHERE actor_user_id = $1', [actorId])
    await pool.query('DELETE FROM analysis_results WHERE resume_id IN (SELECT id FROM resumes WHERE candidate_id = $1)', [candidateId ?? null])
    await pool.query('DELETE FROM analysis_tasks WHERE resume_id IN (SELECT id FROM resumes WHERE candidate_id = $1)', [candidateId ?? null])
    await pool.query('DELETE FROM resumes WHERE candidate_id = $1', [candidateId ?? null])
    for (const table of ['applications', 'candidates', 'jobs', 'workflow_events']) await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [organizationId])
    await pool.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [organizationId, actorId])
    await pool.query('DELETE FROM users WHERE id = $1', [actorId])
    await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId])
    await pool.end()
  }
})
