import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { RecruitingService } from './service.js'
import { LocalRecruitingStore } from './store.js'

const temporaryDirectories: string[] = []

async function createLocalFixture(content = 'Java Spring Boot PostgreSQL, 8 years experience') {
  process.env.NODE_ENV = 'test'
  const directory = await mkdtemp(join(tmpdir(), 'recruiting-analysis-gate-'))
  temporaryDirectories.push(directory)
  const store = new LocalRecruitingStore()
  const service = new RecruitingService(store, directory)
  const created = await service.createResume({
    candidateId: 'candidate-8821',
    applicationId: 'application-8821',
    originalFilename: 'resume.txt',
    mimeType: 'text/plain',
    content,
  })
  return { service, store, created, directory }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('resume analysis scan gate', () => {
  it('allows historical non-infected resume statuses to be analyzed', async () => {
    const { service, store, created } = await createLocalFixture()

    await service.processAnalysisTask(created.task.id)

    const state = await store.read()
    const task = state.analysisTasks.find((item) => item.id === created.task.id)
    assert.equal(task?.status, 'completed')
    assert.equal(task?.attempts, 1)
    assert.equal(state.analysisResults.length, 1)
  })

  it('rejects a non-clean PostgreSQL resume without updating the task', async () => {
    process.env.NODE_ENV = 'test'
    const service = new RecruitingService()
    let updateCalls = 0
    ;(service as any).repository = {
      getAnalysisTask: async () => ({ id: 'task-1', resumeId: 'resume-1', applicationId: null, status: 'queued', attempts: 0, idempotencyKey: 'key-1', lastError: null, availableAt: new Date().toISOString(), startedAt: null, completedAt: null, createdAt: new Date().toISOString() }),
      getResume: async () => ({ id: 'resume-1', candidateId: 'candidate-1', applicationId: null, storageKey: 'resume.txt', originalFilename: 'resume.txt', mimeType: 'text/plain', sizeBytes: 10, scanStatus: 'infected', contentHash: 'hash', createdAt: new Date().toISOString() }),
      updateAnalysisTask: async () => { updateCalls += 1; throw new Error('must not update') },
    }

    await assert.rejects(
      service.processAnalysisTask('task-1'),
      (error: any) => error?.code === 'RESUME_SCAN_NOT_CLEAN' && error?.status === 409,
    )
    assert.equal(updateCalls, 0)
  })

  it('allows a clean local resume to complete analysis', async () => {
    const { service, store, created } = await createLocalFixture()
    await store.transaction((state) => {
      const resume = state.resumes.find((item) => item.id === created.resume.id)
      assert.ok(resume)
      resume.scanStatus = 'clean'
    })

    const task = await service.processAnalysisTask(created.task.id)
    assert.equal(task.status, 'completed')
    const state = await store.read()
    assert.equal(state.resumes.find((item) => item.id === created.resume.id)?.scanStatus, 'clean')
    assert.equal(state.analysisResults.length, 1)
  })

  it('backfills candidate profile fields from the parsed resume', async () => {
    const { service, store, created } = await createLocalFixture([
      '张伟',
      '邮箱：zhangwei@example.com',
      '电话：13800138000',
      '技能：TypeScript、PostgreSQL',
    ].join('\n'))
    await store.transaction((state) => {
      const candidate = state.candidates.find((item) => item.id === 'candidate-8821')
      assert.ok(candidate)
      candidate.fullName = '待解析候选人'
      delete candidate.email
      delete candidate.phone
    })

    await service.processAnalysisTask(created.task.id)

    const state = await store.read()
    const candidate = state.candidates.find((item) => item.id === 'candidate-8821')
    assert.equal(candidate?.fullName, '张伟')
    assert.equal(candidate?.email, 'zhangwei@example.com')
    assert.equal(candidate?.phone, '13800138000')
  })

  it('queues a new analysis task for reanalysis and reuses an active task', async () => {
    const { service, store, created } = await createLocalFixture('姓名：张伟\n邮箱：zhangwei@example.com\n电话：13800138000\n技能：Java、Spring Boot')
    // Uploads create the first task immediately. Complete it before requesting
    // reanalysis so this assertion covers the intended new-task path instead
    // of the idempotent active-task reuse path.
    await service.processAnalysisTask(created.task.id)
    const first = await service.reanalyzeResume('candidate-8821', created.resume.id, 'reviewer-1')
    assert.equal(first.status, 'queued')
    const second = await service.reanalyzeResume('candidate-8821', created.resume.id, 'reviewer-1')
    assert.equal(second.id, first.id)

    const state = await store.read()
    assert.equal(state.analysisTasks.filter((task) => task.resumeId === created.resume.id).length, 2)
    assert.ok(state.workflowEvents.some((event) => event.subjectId === 'candidate-8821' && event.action === 'resume_reanalysis_requested'))
  })

  it('repairs template labels using an explicit spaced name without overwriting a real name', async () => {
    for (const existingName of ['PERSONAL RESUME', '现居', '应用统计学', '王思远']) {
      const { service, store, created } = await createLocalFixture('PERSONAL RESUME\n姓 名：李明\n技能：Python、FastAPI')
      await store.transaction((state) => { state.candidates.find((item) => item.id === 'candidate-8821')!.fullName = existingName })
      await service.processAnalysisTask(created.task.id)
      const candidate = (await store.read()).candidates.find((item) => item.id === 'candidate-8821')
      assert.equal(candidate?.fullName, existingName === '王思远' ? '王思远' : '李明')
    }
  })

  it('repairs appended personal fields but preserves a different or manually annotated name', async () => {
    for (const existingName of ['张惠亭 政治面貌：共青团员', '张 惠 亭｜民 族：汉', '王思远', '王思远 政治面貌：群众', '张惠亭（人工确认）']) {
      const { service, store, created } = await createLocalFixture('姓 名：张惠亭 政治面貌：共青团员\n专业技能\nPython')
      await store.transaction((state) => { state.candidates.find((item) => item.id === 'candidate-8821')!.fullName = existingName })
      await service.processAnalysisTask(created.task.id)
      assert.equal((await store.read()).candidates.find((item) => item.id === 'candidate-8821')?.fullName,
        ['张惠亭 政治面貌：共青团员', '张 惠 亭｜民 族：汉'].includes(existingName) ? '张惠亭' : existingName)
    }
  })

  it('reanalysis creates a fresh result and corrects a placeholder candidate name', async () => {
    const { service, store, created } = await createLocalFixture('姓名：张伟\n邮箱：zhangwei@example.com\n电话：13800138000')
    await service.processAnalysisTask(created.task.id)
    await store.transaction((state) => {
      const candidate = state.candidates.find((item) => item.id === 'candidate-8821')
      assert.ok(candidate)
      candidate.fullName = '教育背景2010.09-2014.06 江城大学'
      delete candidate.email
      delete candidate.phone
    })

    const task = await service.reanalyzeResume('candidate-8821', created.resume.id)
    await service.processAnalysisTask(task.id)

    const state = await store.read()
    const candidate = state.candidates.find((item) => item.id === 'candidate-8821')
    assert.equal(candidate?.fullName, '张伟')
    assert.equal(candidate?.email, 'zhangwei@example.com')
    assert.equal(candidate?.phone, '13800138000')
    assert.equal(state.analysisResults.filter((result) => result.resumeId === created.resume.id).length, 2)
  })

  it('records human edits to the analysis result and score', async () => {
    const { service, store, created } = await createLocalFixture()
    await service.processAnalysisTask(created.task.id)
    const before = await store.read()
    const result = before.analysisResults.find((item) => item.analysisTaskId === created.task.id)
    assert.ok(result)
    const originalScore = (result.result.assessment as { score?: number }).score

    const updated = await service.reviewAnalysisResult(result.id, {
      status: 'accepted',
      comment: '人工调整评分依据',
      edits: {
        score: 88,
        recommendation: 'match',
        strengths: ['具备后端工程经验'],
        risks: ['需要补充系统设计面试'],
      },
    }, 'reviewer-1')

    assert.equal((updated.result.assessment as { score?: number }).score, 88)
    const history = (updated.result.humanReview as { history?: Array<{ before?: { score?: number }; after?: { score?: number }; editedBy?: string; comment?: string }> }).history
    assert.equal(history?.length, 1)
    assert.equal(history?.[0]?.before?.score, originalScore)
    assert.equal(history?.[0]?.after?.score, 88)
    assert.equal(history?.[0]?.editedBy, 'reviewer-1')
    assert.equal(history?.[0]?.comment, '人工调整评分依据')
  })
})

describe('local confirmed scoring baseline', () => {
  it('keeps confirmed spec requirements while the editor displays a newer draft', async () => {
    const { service, store, created } = await createLocalFixture()
    await service.createSpec('job-108', {
      title: 'Draft', summary: 'Unconfirmed changes', responsibilities: [],
      requirements: [{ label: '销售经验', description: '', required: true }], skills: ['销售'],
    })
    assert.equal((await service.getJob('job-108')).spec?.confirmed, false)
    assert.equal((await service.processAnalysisTask(created.task.id)).status, 'completed')
    const state = await store.read()
    const report = state.analysisResults.find((item) => item.analysisTaskId === created.task.id)!.result
    const assessment = report.assessment as { matchedRequirements: Array<{ label: string }>; missingRequirements: Array<{ label: string }> }
    const labels = [...assessment.matchedRequirements, ...assessment.missingRequirements].map((item) => item.label)
    assert.ok(labels.includes('本科及以上学历：计算机相关专业优先'))
    assert.ok(!labels.some((label) => label.includes('销售')))
  })

  it('uses confirmed JD history when the confirmed spec is empty and the latest JD is a draft', async () => {
    const { service, store, created } = await createLocalFixture()
    await store.transaction((state) => {
      const job = state.jobs.find((item) => item.id === 'job-108')!
      job.spec = { ...job.spec!, version: 2, requirements: [], skills: [], confirmed: true }
      job.jd = { ...job.jd!, version: 2, content: '任职要求\n掌握Java\n岗位职责\n维护系统', confirmed: true }
    })
    await service.createJd('job-108', { language: 'zh-CN', content: '任职要求\n销售经验' })
    assert.equal((await service.getJob('job-108')).jd?.confirmed, false)
    assert.equal((await service.processAnalysisTask(created.task.id)).status, 'completed')
    const state = await store.read()
    const report = state.analysisResults.find((item) => item.analysisTaskId === created.task.id)!.result
    const assessment = report.assessment as { score: number | null; matchedRequirements: Array<{ label: string }>; missingRequirements: Array<{ label: string }> }
    assert.notEqual(assessment.score, null)
    assert.deepEqual([...assessment.matchedRequirements, ...assessment.missingRequirements].map((item) => item.label), ['掌握Java'])
  })
})

describe('interview deletion', () => {
  it('removes an interview and its feedback while preserving the application and audit event', async () => {
    process.env.NODE_ENV = 'test'
    const store = new LocalRecruitingStore()
    const service = new RecruitingService(store)
    const interview = await service.createInterview({
      applicationId: 'application-8821',
      title: 'Technical interview',
      participants: [{ userId: 'interviewer-1', role: 'interviewer' }],
    })
    await service.submitFeedback(interview.id, { interviewerId: 'interviewer-1', overallScore: 85 })
    const statusBeforeDelete = (await store.read()).applications.find((item) => item.id === interview.applicationId)?.status

    await service.deleteInterview(interview.code, 'recruiter-1')

    const state = await store.read()
    assert.equal(state.interviews.some((item) => item.id === interview.id), false)
    assert.equal(state.interviewFeedback.some((item) => item.interviewId === interview.id), false)
    assert.equal(state.applications.some((item) => item.id === interview.applicationId), true)
    assert.equal(state.applications.find((item) => item.id === interview.applicationId)?.status, statusBeforeDelete)
    assert.ok(state.workflowEvents.some((item) => item.subjectId === interview.id && item.action === 'delete'))
    await assert.rejects(service.deleteInterview('INT-999999'), (error: any) => error?.code === 'NOT_FOUND')
  })
})

describe('candidate tags', () => {
  it('does not materialize a repository snapshot when tags are not persisted', async () => {
    process.env.NODE_ENV = 'test'
    const service = new RecruitingService()
    ;(service as any).repository = {}

    assert.deepEqual(await service.listCandidateTags(), [])
  })
})

describe('offer onboarding archive', () => {
  it('reuses the existing onboarding record when archive is repeated', async () => {
    process.env.NODE_ENV = 'test'
    const directory = await mkdtemp(join(tmpdir(), 'recruiting-onboarding-'))
    temporaryDirectories.push(directory)
    const store = new LocalRecruitingStore()
    const service = new RecruitingService(store, directory)
    const interview = await service.createInterview({ applicationId: 'application-8814', round: 2, title: 'Final', participants: [{ userId: 'user-demo', role: 'interviewer' }] })
    await service.submitFeedback(interview.id, { interviewerId: 'user-demo', overallScore: 90 })
    await service.lockFeedback(interview.id, 'user-demo')
    await service.concludeInterview(interview.id, 'offer')
    const offer = await service.createOffer({
      applicationId: 'application-8814',
      positionTitle: '测试工程师',
      departmentId: 'dept-tech',
      employmentType: 'full_time',
      baseSalary: { amount: 20000, currency: 'CNY' },
      content: '欢迎加入',
    })

    await service.offerAction(offer.id, 'submit_approval')
    await service.offerAction(offer.id, 'approve')
    await service.offerAction(offer.id, 'send')
    await service.offerAction(offer.id, 'accept')
    const first = await service.offerAction(offer.id, 'archive_onboarding')
    const second = await service.offerAction(offer.id, 'archive_onboarding')

    assert.equal(second.id, first.id)
    const state = await store.read()
    assert.equal(state.onboarding.filter((item) => item.offerId === offer.id).length, 1)
  })
})

describe('candidate deletion', () => {
  it('deletes the candidate, applications, resumes and AI data while retaining audit history', async () => {
    const { service, store, created, directory } = await createLocalFixture()
    await service.processAnalysisTask(created.task.id)
    await access(join(directory, created.resume.storageKey))
    await service.deleteCandidate('candidate-8821', 'user-demo')
    const state = await store.read()
    assert.ok(!state.candidates.some((item) => item.id === 'candidate-8821'))
    assert.ok(!state.applications.some((item) => item.candidateId === 'candidate-8821'))
    assert.equal(state.resumes.length, 0)
    assert.equal(state.analysisTasks.length, 0)
    assert.equal(state.analysisResults.length, 0)
    assert.equal(state.candidates.length, 2)
    await assert.rejects(access(join(directory, created.resume.storageKey)), (error: any) => error.code === 'ENOENT')
    assert.ok(state.workflowEvents.some((item) => item.subjectId === 'candidate-8821' && item.action === 'delete'))
    await assert.rejects(service.getCandidate('candidate-8821'), (error: any) => error.status === 404)
  })

  it('does not partially delete when analysis is running', async () => {
    const { service, store, created } = await createLocalFixture()
    await store.transaction((state) => { state.analysisTasks[0]!.status = 'processing' })
    const before = await store.read()
    await assert.rejects(service.deleteCandidate('candidate-8821'), (error: any) => error.code === 'CANDIDATE_ANALYSIS_IN_PROGRESS')
    assert.deepEqual(await store.read(), before)
  })

  it('protects existing interview records', async () => {
    const { service, store } = await createLocalFixture()
    await store.transaction((state) => {
      state.interviews.push({ id: 'interview-test', applicationId: 'application-8821' } as never)
    })
    const before = await store.read()
    await assert.rejects(service.deleteCandidate('candidate-8821'), (error: any) => error.code === 'CANDIDATE_IN_USE')
    assert.deepEqual(await store.read(), before)
  })
})

for (const entity of ['offers', 'onboarding'] as const) {
  it(`prevents candidate deletion when ${entity} exists`, async () => {
    const { service, store } = await createLocalFixture()
    await store.transaction((state) => { state[entity].push({ id: `${entity}-test`, applicationId: 'application-8821' } as never) })
    const before = await store.read()
    await assert.rejects(service.deleteCandidate('candidate-8821'), (error: any) => error.code === 'CANDIDATE_IN_USE')
    assert.deepEqual(await store.read(), before)
  })
}


describe('interview enterprise access', () => {
  it('checks the enterprise boundary even when the user has no department restriction', async () => {
    const service = new RecruitingService()
    let checked = false
    service.getInterview = async () => { checked = true; throw new Error('outside enterprise') }
    await assert.rejects(service.assertInterviewInScope('foreign-interview'), /outside enterprise/)
    assert.equal(checked, true)
  })
})


describe('dashboard resume count', () => {
  it('counts uploaded resumes rather than applications, including multiple resumes and resumes without an application', async () => {
    const { service, store, created } = await createLocalFixture()
    await store.transaction(state => {
      state.resumes.push({ ...created.resume, id: 'resume-second-version' })
      const { applicationId: _applicationId, ...unlinkedResume } = created.resume
      state.resumes.push({ ...unlinkedResume, id: 'resume-talent-pool' })
      state.resumes.push({ ...created.resume, id: 'resume-other-candidate', candidateId: 'candidate-8814', applicationId: 'application-8814' })
    })
    const dashboard = await service.getDashboardSummary()
    assert.deepEqual(dashboard.metrics[0], { label: '简历数量', value: 4, detail: '已上传的简历总数' })
    assert.equal(dashboard.funnel[0]?.count, 3)
    assert.equal(dashboard.funnel[0]?.stage, '收到申请')
    const scoped = await service.getDashboardSummary('dept-tech')
    assert.equal(scoped.metrics[0]?.value, 3)
    assert.equal(scoped.funnel[0]?.count, 1)
    const report = await service.getReports()
    assert.equal(report.summary[0]?.label, '收到申请')
    assert.equal(report.summary[0]?.value, 3)
  })
  it('shows zero resumes even when applications already exist', async () => {
    process.env.NODE_ENV = 'test'
    const service = new RecruitingService(new LocalRecruitingStore())
    const dashboard = await service.getDashboardSummary()
    assert.equal(dashboard.metrics[0]?.value, 0)
    assert.equal(dashboard.funnel[0]?.count, 3)
  })
})


describe('job manager names', () => {
  it('preserves multiple free-text names on creation, update, read and clear', async () => {
    process.env.NODE_ENV = 'test'
    const service = new RecruitingService(new LocalRecruitingStore())
    const created = await service.createJob({ title: '会计2', departmentId: 'dept-tech', hiringManagerId: '  张三、李四  ', headcount: 1, employmentType: 'full_time', workMode: 'hybrid' })
    assert.equal(created.hiringManagerId, '张三、李四')
    assert.equal((await service.getJob(created.id)).hiringManagerId, '张三、李四')
    assert.equal((await service.updateJob(created.id, { hiringManagerId: '  王五、赵六  ' })).hiringManagerId, '王五、赵六')
    assert.equal((await service.getJob(created.id)).hiringManagerId, '王五、赵六')
    assert.equal((await service.updateJob(created.id, { title: '会计3' })).hiringManagerId, '王五、赵六')
    assert.equal((await service.updateJob(created.id, { hiringManagerId: '' })).hiringManagerId || '', '')
  })
})
