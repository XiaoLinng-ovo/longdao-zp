import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { ObjectStorage } from '@smartrecruit-pro/object-storage'
import { assessSemanticResume, buildJobAnalysisContext, buildJobRequirements, buildRuleBasedReport, type AnalysisReport } from '@smartrecruit-pro/resume-intelligence'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository } from '../src/recruiting/repositories/postgres-repository.js'
import { RecruitingService } from '../src/recruiting/service.js'

test('PostgreSQL queues semantic scoring and presents the newest validated Worker result everywhere', async (context) => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool()
  const organizationId = randomUUID()
  const jobId = randomUUID()
  const applicationId = randomUUID()
  const objects = new Map<string, Buffer>()
  let candidateId: string | undefined
  const storage: ObjectStorage = {
    kind: 'local',
    async put(key, body) { objects.set(key, Buffer.from(body)) },
    async get(key) { const body = objects.get(key); if (!body) throw new Error('missing test object'); return body },
    async delete(key) { objects.delete(key) },
    async health() { return true },
  }
  const repository = new NormalizedRecruitingRepository(pool, { organizationId })
  const service = new RecruitingService(undefined, undefined, storage, repository)
  // Simulated Worker/model output: this integration checks dispatch, confirmed context,
  // persistence and latest-result presentation, not live model reasoning quality.
  async function processWithSimulatedWorker(taskId: string) {
    const queued = await service.processAnalysisTask(taskId)
    if (queued.status === 'completed') return queued // Parsing-only job, no score.
    assert.equal(queued.status, 'queued')
    assert.equal(queued.attempts, 0)
    const task = await repository.getAnalysisTask(taskId)
    const resume = await repository.getResume(task.resumeId)
    const content = (await storage.get(resume.storageKey)).toString('utf8')
    const specs = await repository.listJobSpecVersions(jobId)
    const jds = await repository.listJobDescriptionVersions(jobId)
    const spec = specs.filter(row => row.confirmedAt).sort((a,b) => b.version-a.version)[0]
    const jd = jds.filter(row => row.confirmedAt).sort((a,b) => b.version-a.version)[0]
    const context = buildJobAnalysisContext({ title: '算法工程师', specContent: spec?.content, jdContent: jd?.content })
    const job = { jobId, title: context.title, requirements: buildJobRequirements({ jobId, requirementLabels: context.requirements, requirementRequired: context.requirementRequired, skills: context.skills }) }
    const report = buildRuleBasedReport({ resume: { fileName: resume.originalFilename, text: content }, job })
    const positive = !content.includes('未掌握')
    report.assessment = assessSemanticResume({ job, extraction: report.extraction, anonymizedResumeText: content, response: {
      score: positive ? 100 : 0,
      requirementAssessments: job.requirements.map(item => ({ requirementId: item.id, status: positive ? 'met' : 'not_mentioned', score: positive ? 100 : 0, sourceTexts: positive ? [content] : [], rationale: '仅供存储链路测试的固定模型响应' })),
    } }).assessment
    report.provenance = { ...report.provenance, engine: 'llm-suggestion', modelName: 'integration-fixture', scorerVersion: '0.1.0' }
    await repository.createAnalysisResult({ analysisTaskId: taskId, resumeId: resume.id, applicationId, result: report as unknown as Record<string, unknown>, analyzerVersion: 'semantic-integration-fixture', inputHash: resume.contentHash })
    return repository.updateAnalysisTask(taskId, { status: 'completed', completedAt: new Date().toISOString() })
  }
  try {
    await pool.query("INSERT INTO organizations (id, name, kind) VALUES ($1, 'resume-score-integration-test', 'test')", [organizationId])
    const candidate = await repository.createCandidate({ name: '评分联调候选人' })
    candidateId = candidate.id
    await pool.query("INSERT INTO jobs (id, organization_id, job_no, title, headcount) VALUES ($1, $2, $3, '算法工程师', 1)", [jobId, organizationId, `JOB-${jobId}`])
    await pool.query('INSERT INTO applications (id, organization_id, application_no, candidate_id, job_id) VALUES ($1, $2, $3, $4, $5)', [applicationId, organizationId, `APP-${applicationId}`, candidate.id, jobId])
    await repository.createJobSpecVersion({ jobId, confirmedAt: new Date().toISOString(), content: {
      title: '算法工程师', summary: '算法开发', skills: ['机器学习', '深度学习', '模型训练与评估', 'Python或其他编程语言'],
      requirements: [
        { label: '学历背景', description: '具备计算机、数学、统计学或人工智能专业背景。', required: false },
        { label: '项目经验', description: '掌握机器学习、深度学习。', required: true },
      ],
    } })
    const texts = [
      '评分联调候选人\n教育经历\n测试大学 | 信息管理 | 本科\n技能\nPython（基础）\n未掌握：机器学习、深度学习、模型训练\n自我评价\n对机器学习、深度学习和模型训练缺乏实际经验。',
      '评分联调候选人\n教育经历\n测试大学 | 计算机科学与技术 | 硕士\n工作经历\n2021-2024 算法工程师\n使用Python完成机器学习、深度学习、模型训练与效果评估。',
    ]
    const scores: number[] = []
    const resumeIds: string[] = []
    for (const [index, content] of texts.entries()) {
      const created = await service.createResume({ candidateId: candidate.id, applicationId, originalFilename: `score-${index}.txt`, mimeType: 'text/plain', content })
      resumeIds.push(created.resume.id)
      await pool.query("UPDATE resumes SET scan_status = 'clean' WHERE id = $1 AND organization_id = $2", [created.resume.id, organizationId])
      const processed = await processWithSimulatedWorker(created.task.id)
      assert.equal(processed.status, 'completed', processed.lastError ?? undefined)
      const result = await repository.getAnalysisResultByTask(created.task.id)
      const report = result.result as unknown as AnalysisReport
      assert.notEqual(report.assessment.score, null)
      scores.push(report.assessment.score!)
      assert.equal(report.provenance.matcherVersion, '0.2.0')
      const assessments = [...report.assessment.matchedRequirements, ...report.assessment.missingRequirements]
      assert.equal(assessments.find((item) => item.label.startsWith('学历背景'))?.hard, false)
      assert.equal(assessments.find((item) => item.label.startsWith('项目经验'))?.hard, true)
    }
    assert.ok(scores[0]! < 35)
    assert.ok(scores[1]! >= 85)
    const latestScore = scores[1]
    const listed = (await service.listCandidates()).find((row) => row.id === candidate.id)!
    assert.equal(listed.score, latestScore)
    assert.equal(listed.applications[0]?.score, latestScore)
    const detail = await service.getCandidate(candidate.id)
    assert.equal(detail.applications[0]?.score, latestScore)
    assert.equal(detail.analysisResults.length, 2, 'keep older analysis results for audit')
    assert.equal(detail.applications[0]?.status, 'pending_analysis', 'scoring must remain advisory')

    // Reanalysis must load the complete job, and a lower new score must replace a higher old one.
    const reanalysis = await service.reanalyzeResume(candidate.id, resumeIds[0]!)
    assert.equal((await processWithSimulatedWorker(reanalysis.id)).status, 'completed')
    const reanalyzed = await repository.getAnalysisResultByTask(reanalysis.id)
    const reanalyzedReport = reanalyzed.result as unknown as AnalysisReport
    assert.equal(reanalyzedReport.assessment.score, scores[0])
    assert.ok(!reanalyzedReport.assessment.risks.some((risk) => risk.includes('岗位未提供任职要求')))
    // Simulate a different repository ordering; list and detail still select the newest timestamp.
    const originalList = repository.listAnalysisResults.bind(repository)
    repository.listAnalysisResults = async (...args) => (await originalList(...args)).reverse()
    const updatedList = (await service.listCandidates()).find((row) => row.id === candidate.id)!
    assert.equal(updatedList.score, scores[0])
    assert.equal(updatedList.applications[0]?.score, scores[0])
    assert.equal((await service.getCandidate(candidate.id)).applications[0]?.score, scores[0])
    repository.listAnalysisResults = originalList

    // An unconfigured job must not fall back to a previous score or to completeness (90).
    await repository.createJobSpecVersion({ jobId, content: { title: '算法工程师', requirements: [], skills: [] } })
    const draftTask = await service.reanalyzeResume(candidate.id, resumeIds[0]!)
    assert.equal((await processWithSimulatedWorker(draftTask.id)).status, 'completed')
    const draftResult = await repository.getAnalysisResultByTask(draftTask.id)
    assert.equal((draftResult.result as unknown as AnalysisReport).assessment.score, scores[0], 'draft must not replace confirmed requirements')
    assert.equal((await service.getJob(jobId)).spec?.confirmed, false, 'editor still displays the latest draft')
    await repository.confirmJobSpecVersion(jobId)
    const noRequirementsTask = await service.reanalyzeResume(candidate.id, resumeIds[0]!)
    assert.equal((await service.processAnalysisTask(noRequirementsTask.id)).status, 'completed')
    const noRequirementsResult = await repository.getAnalysisResultByTask(noRequirementsTask.id)
    assert.equal((noRequirementsResult.result as unknown as AnalysisReport).assessment.score, null)
    const unscored = (await service.listCandidates()).find((row) => row.id === candidate.id)!
    assert.equal(unscored.score, null)
    assert.equal(unscored.applications[0]?.score, undefined)

    // Confirmed JD is the fallback; a newer JD draft is not a scoring baseline.
    await repository.createJobDescriptionVersion({ jobId, content: '岗位职责\n算法开发\n任职要求\n掌握机器学习、深度学习\n技能要求\nPython\n福利待遇\n五险一金' })
    await repository.confirmJobDescriptionVersion(jobId)
    await repository.createJobDescriptionVersion({ jobId, content: '任职要求\n销售经验' })
    const jdTask = await service.reanalyzeResume(candidate.id, resumeIds[1]!)
    assert.equal((await processWithSimulatedWorker(jdTask.id)).status, 'completed')
    const jdResult = await repository.getAnalysisResultByTask(jdTask.id)
    const jdReport = jdResult.result as unknown as AnalysisReport
    assert.notEqual(jdReport.assessment.score, null)
    const jdLabels = [...jdReport.assessment.matchedRequirements, ...jdReport.assessment.missingRequirements].map((item) => item.label)
    assert.ok(jdLabels.includes('掌握机器学习、深度学习'))
    assert.ok(!jdLabels.some((label) => /五险|销售|算法开发/u.test(label)))
    assert.equal((await service.listCandidates()).find((row) => row.id === candidate.id)?.score, jdReport.assessment.score)

    await repository.createJobSpecVersion({ jobId, confirmedAt: new Date().toISOString(), content: { requirements: [{ label: '掌握Python', required: true }], skills: ['Python'] } })
    const preferredTask = await service.reanalyzeResume(candidate.id, resumeIds[1]!)
    assert.equal((await processWithSimulatedWorker(preferredTask.id)).status, 'completed')
    const preferred = (await repository.getAnalysisResultByTask(preferredTask.id)).result as unknown as AnalysisReport
    const preferredLabels = [...preferred.assessment.matchedRequirements, ...preferred.assessment.missingRequirements].map((item) => item.label)
    assert.ok(preferredLabels.includes('掌握Python'))
    assert.ok(!preferredLabels.includes('掌握机器学习、深度学习'), 'structured confirmed spec takes precedence')
  } finally {
    // Resumes are legacy-scoped rows in older schemas, so clean them by the
    // candidate relationship rather than relying only on organization_id.
    await pool.query('DELETE FROM analysis_results WHERE resume_id IN (SELECT id FROM resumes WHERE candidate_id = $1)', [candidateId ?? null])
    await pool.query('DELETE FROM analysis_tasks WHERE resume_id IN (SELECT id FROM resumes WHERE candidate_id = $1)', [candidateId ?? null])
    await pool.query('DELETE FROM resumes WHERE candidate_id = $1', [candidateId ?? null])
    // The cleanup is restricted to the disposable organization created above.
    for (const table of ['applications', 'candidates', 'job_spec_versions', 'job_description_versions', 'jobs', 'workflow_events']) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [organizationId])
    }
    await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId])
    await pool.end()
  }
})

