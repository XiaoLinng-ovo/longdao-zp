import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { RecruitingService } from './service.js'
import { LocalRecruitingStore } from './store.js'

const temporaryDirectories: string[] = []

describe('面试结论更正', () => {
  it('面试详情返回最近一次记录的结论', async () => {
    process.env.NODE_ENV = 'test'
    const service = new RecruitingService(new LocalRecruitingStore())
    const interview = await service.createInterview({
      applicationId: 'application-8814', round: 1, title: '初试', participants: [],
    })
    await service.completeInterview(interview.id, 'reject', 'user-demo')

    assert.equal((await service.getInterview(interview.id)).outcome, 'reject')
  })

  it('保留更正审计，并允许更正初试结论时取消或恢复尚未开展的复试', async () => {
    process.env.NODE_ENV = 'test'
    const store = new LocalRecruitingStore()
    const service = new RecruitingService(store)
    const interview = await service.createInterview({
      applicationId: 'application-8814', round: 1, title: '初试', participants: [],
    })
    await service.completeInterview(interview.id, 'continue', 'user-demo')
    let state = await store.read()
    const finalInterview = state.interviews.find(item => item.applicationId === interview.applicationId && item.round === 2)!
    assert.equal(finalInterview.status, 'scheduled')

    await service.correctInterviewConclusion(interview.id, 'reject', '复核后发现误选', 'user-demo')
    state = await store.read()
    assert.equal(state.interviews.find(item => item.id === finalInterview.id)?.status, 'cancelled')
    assert.equal(state.workflowEvents.at(-1)?.action, 'correct_conclusion')
    assert.equal(state.workflowEvents.at(-1)?.reason, '复核后发现误选')

    await service.correctInterviewConclusion(interview.id, 'continue', '恢复晋级结论', 'user-demo')
    state = await store.read()
    assert.equal(state.interviews.find(item => item.id === finalInterview.id)?.status, 'scheduled')
    assert.equal(state.workflowEvents.filter(event => event.action === 'correct_conclusion').length, 2)
  })

  it('更正初试结论时不取消手动安排的复试', async () => {
    process.env.NODE_ENV = 'test'
    const store = new LocalRecruitingStore()
    const service = new RecruitingService(store)
    const initialInterview = await service.createInterview({
      applicationId: 'application-8814', round: 1, title: '初试', participants: [],
    })
    const manuallyScheduledFinalInterview = await service.createInterview({
      applicationId: 'application-8814', round: 2, title: '人工安排的复试',
      participants: [{ userId: 'user-demo', role: 'interviewer' }],
    })
    await service.completeInterview(initialInterview.id, 'continue', 'user-demo')
    await service.correctInterviewConclusion(initialInterview.id, 'reject', '复核后发现误选', 'user-demo')

    const state = await store.read()
    assert.equal(state.interviews.find(item => item.id === manuallyScheduledFinalInterview.id)?.status, 'scheduled')
  })
})

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

async function createOnboardingFixture() {
  process.env.NODE_ENV = 'test'
  const store = new LocalRecruitingStore()
  const service = new RecruitingService(store)
  const interview = await service.createInterview({
    applicationId: 'application-8814',
    round: 2,
    title: 'Final',
    participants: [{ userId: 'user-demo', role: 'interviewer' }],
  })
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
  await service.offerAction(offer.id, 'send')
  await service.offerAction(offer.id, 'accept')
  const onboarding = await service.offerAction(offer.id, 'archive_onboarding')
  return { service, store, offer, onboarding }
}

describe('Offer invoice details', () => {
  it('saves, preserves, revises and clears invoice details without changing earlier versions', async () => {
    process.env.NODE_ENV = 'test'
    const service = new RecruitingService(new LocalRecruitingStore())
    const interview = await service.createInterview({
      applicationId: 'application-8814', round: 2, title: 'Final',
      participants: [{ userId: 'user-demo', role: 'interviewer' }],
    })
    await service.submitFeedback(interview.id, { interviewerId: 'user-demo', overallScore: 90 })
    await service.lockFeedback(interview.id, 'user-demo')
    await service.concludeInterview(interview.id, 'offer')
    const input = {
      applicationId: 'application-8814', positionTitle: '测试工程师', departmentId: 'dept-tech', employmentType: 'full_time',
      baseSalary: { amount: 20000, currency: 'CNY' }, content: '<p>{{发票抬头}} {{企业税号}}</p>',
      invoiceTitle: '  测试科技有限公司  ', taxNumber: '  TEST9133  ',
      templateFields: { reportingTime: '09:30', supervisorName: ' 王经理 ', payday: '15' },
    }
    const offer = await service.createOffer(input)
    let context = await service.getOfferEmailContext(offer.id)
    assert.equal(context.invoiceTitle, '测试科技有限公司')
    assert.equal(context.taxNumber, 'TEST9133')
    assert.deepEqual(context.templateFields, { reportingTime: '09:30', supervisorName: '王经理', payday: '15' })
    await service.updateOffer(offer.id, { positionTitle: '修订岗位' })
    context = await service.getOfferEmailContext(offer.id)
    assert.equal(context.templateFields?.reportingTime, '09:30')
    assert.equal(context.invoiceTitle, '测试科技有限公司')
    assert.equal(context.taxNumber, 'TEST9133')
    await service.updateOffer(offer.id, { invoiceTitle: '新公司', taxNumber: 'NEW9133', templateFields: { supervisorName: '李经理' } })
    context = await service.getOfferEmailContext(offer.id)
    assert.equal(context.invoiceTitle, '新公司')
    assert.equal(context.taxNumber, 'NEW9133')
    assert.deepEqual(context.templateFields, { reportingTime: '09:30', supervisorName: '李经理', payday: '15' })
    await service.updateOffer(offer.id, { invoiceTitle: '', taxNumber: '   ' })
    context = await service.getOfferEmailContext(offer.id)
    assert.equal(context.invoiceTitle, undefined)
    assert.equal(context.taxNumber, undefined)
    const detail = await service.getOffer(offer.id)
    const originalVersion = detail.versions.find(version => version.version === 1)
    assert.equal(originalVersion?.invoiceTitle, '测试科技有限公司')
    assert.equal(originalVersion?.taxNumber, 'TEST9133')
    assert.equal(originalVersion?.templateFields?.supervisorName, '王经理')
    for (const patch of [{ invoiceTitle: 123 }, { taxNumber: null }, { invoiceTitle: 'x'.repeat(201) }, { taxNumber: 'x'.repeat(101) }]) {
      await assert.rejects(service.updateOffer(offer.id, patch as never), (error: any) => error.code === 'VALIDATION_ERROR')
      await assert.rejects(service.createOffer({ ...input, ...patch } as never), (error: any) => error.code === 'VALIDATION_ERROR')
    }
    assert.equal((await service.getOffer(offer.id)).versions.length, 4)
    await service.offerAction(offer.id, 'send')
    const sentOffer = await service.updateOffer(offer.id, { positionTitle: '已发送后修订岗位' })
    const revised = await service.getOffer(offer.id)
    assert.equal(sentOffer.status, 'sent')
    assert.equal(revised.versions.find((version) => version.version === 5)?.positionTitle, '已发送后修订岗位')
    assert.equal(revised.versions.length, 5)
    assert.equal(revised.versions.find((version) => version.version === 4)?.positionTitle, '修订岗位')
  })
})

async function prepareAndScheduleOnboarding(service: RecruitingService, onboardingId: string) {
  await service.updateOnboarding(onboardingId, {
    plannedStartDate: '2026-11-10',
    plannedStartTime: '09:30',
    reportingMode: 'onsite',
    reportingLocation: 'A 座 12 层',
    reportingContactName: '刘敏',
    reportingContactPhone: '13800000000',
  })
  await service.onboardingAction(onboardingId, 'prepare')
  return service.onboardingAction(onboardingId, 'schedule')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('personalized interview question resume context', () => {
  it('preserves manually corrected candidate names through parsing and reanalysis', async () => {
    const { service, store, created } = await createLocalFixture('姓名：张伟\n专业技能\nPython FastAPI 项目开发经验')
    await service.updateCandidate('candidate-8821', { fullName: '张惠亭' })
    await service.processAnalysisTask(created.task.id)
    const task = await service.reanalyzeResume('candidate-8821', created.resume.id)
    await service.processAnalysisTask(task.id)
    const candidate = (await store.read()).candidates.find(item => item.id === 'candidate-8821')!
    assert.equal(candidate.fullName, '张惠亭')
    assert.equal(candidate.nameManuallyEdited, true)
    for (const fullName of ['', ' ', 'a'.repeat(61), '姓名\n控制字符']) {
      await assert.rejects(service.updateCandidate('candidate-8821', { fullName }), /候选人姓名/u)
    }
  })
  it('prefers the full original resume for this application, not a summary or another application resume', async () => {
    const service = new RecruitingService()
    const ownText = '张小明\n课程项目：校园预约系统，使用 TypeScript 完成接口实现。\n邮箱：xiaoming@example.com'
    const candidate = {
      fullName: '张小明',
      resumes: [
        { id: 'own', applicationId: 'target', createdAt: '2026-10-01', scanStatus: 'clean' },
        { id: 'other', applicationId: 'different', createdAt: '2026-10-24', scanStatus: 'clean' },
      ],
      analysisTasks: [],
      analysisResults: [
        { id: 'result-own', resumeId: 'own', applicationId: 'target', createdAt: '2026-10-01', result: { analysis: { report: { parsedResume: { normalizedText: ownText }, extraction: { profile: { summary: '计算机专业学生' } } } } } },
        { id: 'result-other', resumeId: 'other', applicationId: 'different', createdAt: '2026-10-24', result: { parsedResume: { normalizedText: '曾任销售总监，管理三十人团队' } } },
      ],
    }
    ;(service as any).getInterview = async () => ({ application: { id: 'target', candidateId: 'person', jobId: 'job' }, round: 1 })
    ;(service as any).getCandidate = async (id: string) => { assert.equal(id, 'person'); return candidate }
    ;(service as any).getJob = async () => ({ title: '应用工程师', spec: { requirements: [{ label: '接口开发' }] } })
    ;(service as any).getResumeObject = async () => { throw new Error('Do not re-read an already parsed resume') }
    const context = await service.getInterviewQuestionContext('interview')
    assert.match(context.anonymizedResume, /校园预约系统/u)
    assert.match(context.anonymizedResume, /TypeScript/u)
    assert.doesNotMatch(context.anonymizedResume, /销售总监|三十人|张小明|xiaoming@example.com/u)
    assert.equal(context.jobTitle, '应用工程师')
    assert.deepEqual(context.jobRequirements, ['接口开发'])
  })
  it('keeps extraction-only historical reports usable without inventing experience', async () => {
    const service = new RecruitingService()
    ;(service as any).getInterview = async () => ({ application: { id: 'target', candidateId: 'person', jobId: 'job' }, round: 2 })
    ;(service as any).getCandidate = async () => ({ fullName: '测试同学', resumes: [{ id: 'resume', applicationId: 'target', createdAt: '2026-10-01', scanStatus: 'clean' }], analysisTasks: [], analysisResults: [{ id: 'result', resumeId: 'resume', applicationId: 'target', createdAt: '2026-10-01', result: { extraction: { education: [{ institution: '测试大学', fieldOfStudy: '计算机' }], skills: [{ value: 'SQL' }] } } }] })
    ;(service as any).getJob = async () => ({ title: '数据分析师' })
    const context = await service.getInterviewQuestionContext('interview')
    assert.match(context.anonymizedResume, /测试大学.*计算机/u)
    assert.match(context.anonymizedResume, /SQL/u)
    assert.equal(context.stage, 'final')
  })
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

  it('reanalysis repairs a heading name from a numeric-contact header without replacing manual identity', async () => {
    for (const existingName of ['荣誉奖项', '荣 誉 与 成 果', '校园经历与荣誉', '林人工']) {
      const { service, store, created } = await createLocalFixture('林测试 13819530001 | 1219534309@example.test\n荣誉奖项：校级奖学金\n专业技能\n编程语言与后端：Python · FastAPI')
      await service.processAnalysisTask(created.task.id)
      await store.transaction((state) => { state.candidates.find((item) => item.id === 'candidate-8821')!.fullName = existingName })
      const task = await service.reanalyzeResume('candidate-8821', created.resume.id)
      await service.processAnalysisTask(task.id)
      assert.equal((await store.read()).candidates.find((item) => item.id === 'candidate-8821')?.fullName, existingName === '林人工' ? existingName : '林测试')
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

describe('initial interview assignment', () => {
  it('allows the first interview without an assigned interviewer but requires one for later rounds', async () => {
    process.env.NODE_ENV = 'test'
    const store = new LocalRecruitingStore()
    const service = new RecruitingService(store)
    const initial = await service.createInterview({ applicationId: 'application-8821', round: 1, title: '初试', participants: [] })

    assert.deepEqual(initial.participants, [])
    await assert.rejects(
      service.createInterview({ applicationId: 'application-8821', round: 2, title: '复试', participants: [] }),
      (error: any) => error?.code === 'INTERVIEWER_REQUIRED',
    )
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

    await service.offerAction(offer.id, 'send')
    await service.offerAction(offer.id, 'accept')
    const first = await service.offerAction(offer.id, 'archive_onboarding')
    const second = await service.offerAction(offer.id, 'archive_onboarding')

    assert.equal(second.id, first.id)
    const state = await store.read()
    assert.equal(state.onboarding.filter((item) => item.offerId === offer.id).length, 1)
    const archivedTasks = await service.listOnboardingTasks(first.id)
    assert.equal(archivedTasks.length, 12)
    assert.deepEqual([...new Set(archivedTasks.map((task) => task.category))].sort(), ['admin', 'candidate', 'hr', 'it', 'manager', 'training'])
    assert.equal((await service.listOnboardingMaterials(first.id)).length, 4)
    assert.equal((await service.listOnboardingIntegrations(first.id)).length, 5)

    await store.transaction((draft) => {
      draft.onboarding.push({ id: 'legacy-onboarding', applicationId: 'application-8814', offerId: 'legacy-offer', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    })
    assert.deepEqual([...new Set((await service.listOnboardingTasks('legacy-onboarding')).map((task) => task.category))].sort(), ['admin', 'candidate', 'hr', 'it', 'manager', 'training'])

    const arranged = await service.updateOnboarding(first.id, {
      plannedStartDate: '2026-11-03',
      plannedStartTime: '09:30',
      reportingMode: 'onsite',
      reportingLocation: 'A 座 12 层',
      reportingContactName: '刘敏',
    })
    assert.equal(arranged.reportingLocation, 'A 座 12 层')
    assert.equal(arranged.reportingMode, 'onsite')
    assert.equal((await service.updateOnboarding(first.id, { plannedStartDate: null, plannedStartTime: null, reportingMode: null })).plannedStartDate, undefined)

    const extraTask = await service.createOnboardingTask(first.id, { title: '开通 VPN 权限', category: 'it', ownerName: 'IT 服务台' })
    await assert.rejects(() => service.updateOnboardingTask(first.id, extraTask.id, { status: 'blocked' }), /阻塞原因/)
    const blocked = await service.updateOnboardingTask(first.id, extraTask.id, { status: 'blocked', blockedReason: '等待网络审批' })
    assert.equal(blocked.blockedReason, '等待网络审批')
    assert.equal((await service.updateOnboardingTask(first.id, extraTask.id, { status: 'completed' })).completedAt !== undefined, true)
  })

  it('requires complete reporting details and creates fifteen reminders after scheduling', async () => {
    const { service, onboarding } = await createOnboardingFixture()
    await service.updateOnboarding(onboarding.id, {
      plannedStartDate: '2026-11-10',
      plannedStartTime: '09:30',
      reportingMode: 'hybrid',
      reportingLocation: 'A 座 12 层 / https://meeting.example.com/onboarding',
      reportingContactName: '刘敏',
    })
    await service.onboardingAction(onboarding.id, 'prepare')

    await assert.rejects(
      () => service.onboardingAction(onboarding.id, 'schedule'),
      (error: any) => error.code === 'ONBOARDING_SCHEDULE_INCOMPLETE' && /联系人电话/u.test(error.message),
    )

    await service.updateOnboarding(onboarding.id, { reportingContactPhone: '13800000000' })
    const scheduled = await service.onboardingAction(onboarding.id, 'schedule')
    assert.equal(scheduled.status, 'scheduled')

    const reminders = await service.listOnboardingReminders(onboarding.id)
    assert.equal(reminders.length, 15)
    assert.equal(new Set(reminders.map((item) => `${item.milestone}:${item.audience}`)).size, 15)
    assert.ok(reminders.every((item) => item.channel === 'in_app' && item.status === 'scheduled'))
    assert.ok(reminders.some((item) => item.milestone === '7_days' && item.scheduledAt === '2026-11-03T09:00:00+08:00'))
    assert.ok(reminders.some((item) => item.milestone === 'day_of' && item.scheduledAt === '2026-11-10T09:00:00+08:00'))
  })

  it('blocks completion until requirements are resolved and allows post-arrival backfills', async () => {
    const { service, store, onboarding } = await createOnboardingFixture()
    await prepareAndScheduleOnboarding(service, onboarding.id)

    await assert.rejects(
      () => service.onboardingAction(onboarding.id, 'complete'),
      (error: any) => error.code === 'ONBOARDING_COMPLETION_BLOCKED' && /12 项必选任务、4 项必选材料/u.test(error.message),
    )

    const tasks = await service.listOnboardingTasks(onboarding.id)
    for (const task of tasks) await service.updateOnboardingTask(onboarding.id, task.id, { status: 'completed' })
    await assert.rejects(
      () => service.onboardingAction(onboarding.id, 'complete'),
      (error: any) => error.code === 'ONBOARDING_COMPLETION_BLOCKED' && /0 项必选任务、4 项必选材料/u.test(error.message),
    )

    const materials = await service.listOnboardingMaterials(onboarding.id)
    for (const material of materials) await service.updateOnboardingMaterial(onboarding.id, material.id, { status: 'verified' })
    const completed = await service.onboardingAction(onboarding.id, 'complete')
    assert.equal(completed.status, 'completed')
    assert.ok(completed.actualArrivalAt)
    assert.ok(completed.archivedAt)

    const state = await store.read()
    assert.equal(state.applications.find((item) => item.id === onboarding.applicationId)?.status, 'onboarding_archived')

    const task = tasks[0]!
    const material = materials[0]!
    const integration = (await service.listOnboardingIntegrations(onboarding.id))[0]!
    const archivedTask = await service.createOnboardingTask(onboarding.id, { title: '报到后补录任务', category: 'hr' })
    await service.updateOnboardingTask(onboarding.id, task.id, { notes: '报到后补录任务备注' })
    const archivedMaterial = await service.createOnboardingMaterial(onboarding.id, { code: 'post_arrival_material', label: '报到后补录材料' })
    await service.updateOnboardingMaterial(onboarding.id, material.id, { notes: '报到后补录材料备注' })
    await service.updateOnboardingIntegration(onboarding.id, integration.id, { status: 'ready', externalReference: 'OA-POST-ARRIVAL' })
    const updated = await service.updateOnboarding(onboarding.id, { reportingContactPhone: '13800000000', notes: '报到后补录交接备注' })
    const refreshedReminders = await service.refreshOnboardingReminders(onboarding.id)

    assert.equal(archivedTask.onboardingId, onboarding.id)
    assert.equal(archivedMaterial.onboardingId, onboarding.id)
    assert.equal(updated.status, 'completed')
    assert.equal(updated.reportingContactPhone, '13800000000')
    assert.equal((await service.getOnboarding(onboarding.id)).notes, '报到后补录交接备注')
    assert.ok(refreshedReminders.length > 0)
  })

  it('requires structured cancellation and no-show reasons with notes for other', async () => {
    const cancelledFixture = await createOnboardingFixture()
    await assert.rejects(
      () => cancelledFixture.service.onboardingAction(cancelledFixture.onboarding.id, 'cancel', { reasonCode: 'other' }),
      (error: any) => error.code === 'ONBOARDING_REASON_NOTES_REQUIRED',
    )
    const cancelled = await cancelledFixture.service.onboardingAction(cancelledFixture.onboarding.id, 'cancel', { reasonCode: 'other', notes: '岗位预算冻结' })
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.cancellationReasonCode, 'other')
    assert.equal(cancelled.cancellationNotes, '岗位预算冻结')
    await assert.rejects(
      () => cancelledFixture.service.updateOnboarding(cancelledFixture.onboarding.id, { notes: '取消后修改' }),
      (error: any) => error.code === 'ONBOARDING_NOT_EDITABLE',
    )

    const noShowFixture = await createOnboardingFixture()
    await prepareAndScheduleOnboarding(noShowFixture.service, noShowFixture.onboarding.id)
    await assert.rejects(
      () => noShowFixture.service.onboardingAction(noShowFixture.onboarding.id, 'no_show', { reasonCode: 'other' }),
      (error: any) => error.code === 'ONBOARDING_REASON_NOTES_REQUIRED',
    )
    const noShow = await noShowFixture.service.onboardingAction(noShowFixture.onboarding.id, 'no_show', { reasonCode: 'other', notes: '候选人突发疾病' })
    assert.equal(noShow.status, 'no_show')
    assert.equal(noShow.noShowReasonCode, 'other')
    assert.equal(noShow.noShowNotes, '候选人突发疾病')
    await assert.rejects(
      () => noShowFixture.service.createOnboardingTask(noShowFixture.onboarding.id, { title: '未报到后新增任务', category: 'hr' }),
      (error: any) => error.code === 'ONBOARDING_NOT_EDITABLE',
    )
  })

  it('aggregates readiness, overdue risks and cancellation reasons for the workbench report', async () => {
    const { service, store, onboarding } = await createOnboardingFixture()
    await service.updateOnboarding(onboarding.id, {
      plannedStartDate: '2026-11-10',
      plannedStartTime: '09:30',
      reportingMode: 'onsite',
      reportingLocation: 'A 座 12 层',
      reportingContactName: '刘敏',
      reportingContactPhone: '13800000000',
      riskNotes: '首日需要生产环境只读权限',
    })
    const [task] = await service.listOnboardingTasks(onboarding.id)
    await service.updateOnboardingTask(onboarding.id, task!.id, { status: 'blocked', blockedReason: '等待审批', dueDate: '2026-10-01' })
    const [integration] = await service.listOnboardingIntegrations(onboarding.id)
    await service.updateOnboardingIntegration(onboarding.id, integration!.id, { status: 'failed', lastError: '账号服务超时' })

    const [workbench] = await service.listOnboardingWorkbench()
    assert.equal(workbench?.readiness, 0)
    assert.equal(workbench?.requiredTasksRemaining, 12)
    assert.equal(workbench?.overdueTasks, 1)
    assert.equal(workbench?.nextDueDate, '2026-10-01')
    assert.ok(workbench?.highRiskReasons.some((reason) => reason.includes('任务已逾期')))
    assert.ok(workbench?.highRiskReasons.some((reason) => reason.includes('任务被阻塞')))
    assert.ok(workbench?.highRiskReasons.some((reason) => reason.includes('系统集成失败')))

    await store.transaction((state) => {
      state.onboarding.push({
        id: 'cancelled-report-onboarding',
        applicationId: 'application-8821',
        offerId: 'cancelled-report-offer',
        status: 'cancelled',
        cancellationReasonCode: 'position_closed',
        cancelledAt: '2026-11-04T00:00:00.000Z',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-04T00:00:00.000Z',
      })
    })

    const report = await service.listOnboardingReport()
    assert.equal(report.totals.all, 2)
    assert.equal(report.totals.pending, 1)
    assert.equal(report.totals.cancelled, 1)
    assert.equal(report.overdueTasks, 1)
    assert.equal(report.blockedTasks, 1)
    assert.equal(report.reasonDistribution[0]?.code, 'position_closed')
    assert.equal(report.reasonDistribution[0]?.label, '岗位关闭')
    assert.equal(report.integrationStatus.failed, 1)
    assert.ok(report.highRiskItems.some((item) => item.onboardingId === onboarding.id))
  })

  it('writes onboarding workflow events for preparation, collaboration and cancellation', async () => {
    const { service, onboarding } = await createOnboardingFixture()
    await service.onboardingAction(onboarding.id, 'prepare')
    await service.updateOnboarding(onboarding.id, {
      plannedStartDate: '2026-11-10',
      plannedStartTime: '09:30',
      reportingMode: 'onsite',
      reportingLocation: 'A 座 12 层',
      reportingContactName: '刘敏',
      reportingContactPhone: '13800000000',
    })
    const [task] = await service.listOnboardingTasks(onboarding.id)
    await service.updateOnboardingTask(onboarding.id, task!.id, { status: 'in_progress' })
    const [material] = await service.listOnboardingMaterials(onboarding.id)
    await service.updateOnboardingMaterial(onboarding.id, material!.id, { status: 'verified' })
    const [integration] = await service.listOnboardingIntegrations(onboarding.id)
    await service.updateOnboardingIntegration(onboarding.id, integration!.id, { status: 'ready', externalReference: 'OA-2026-001' })
    await service.onboardingAction(onboarding.id, 'schedule')
    await service.onboardingAction(onboarding.id, 'cancel', { reasonCode: 'schedule_changed' })

    const events = await service.listWorkflowEvents({ subjectType: 'onboarding', limit: 100 })
    const actions = new Set(events.map((event) => event.action))
    for (const action of ['archive_onboarding', 'prepare', 'update', 'task_update', 'material_verify', 'integration_update', 'schedule', 'reminders_refresh', 'cancel']) {
      assert.ok(actions.has(action), `missing onboarding workflow event ${action}`)
    }
    const cancellation = events.find((event) => event.action === 'cancel')
    assert.equal(cancellation?.fromStatus, 'scheduled')
    assert.equal(cancellation?.toStatus, 'cancelled')
    assert.equal(cancellation?.reason, '报到时间调整')
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
  it('only loads review status for scoped non-cancelled interviews and includes unscored online sessions', async () => {
    process.env.NODE_ENV = 'test'
    const store = new LocalRecruitingStore()
    const service = new RecruitingService(store)
    await store.transaction(state => {
      const base = { code: 'IV', round: 1, stage: 'initial' as const, type: 'technical' as const,
        title: '初试', status: 'completed' as const, participants: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }
      state.interviews.push({ ...base, id: 'tech', applicationId: 'application-8821' },
        { ...base, id: 'other', applicationId: 'application-8814' },
        { ...base, id: 'cancelled', applicationId: 'application-8821', status: 'cancelled' })
      state.interviewFeedback.push({ id: 'feedback', interviewId: 'tech', interviewerId: 'hr', status: 'locked', ratings: {}, strengths: [], concerns: [] })
    })
    const dashboard = await service.getDashboardSummary('dept-tech', async ids => {
      assert.deepEqual(ids, ['tech'])
      return [{ interviewId: 'tech', stage: 'initial', hasCompletedLive: true, decision: null, sheets: [] }]
    })
    assert.ok(dashboard.todos.some(row => row.id === 'sheets-application-8821-initial'))
    assert.ok(!dashboard.todos.some(row => row.id === 'feedback-tech'))
    assert.equal(dashboard.pendingInterviews.length, 0)
    assert.ok(!dashboard.todos.some(row => row.description.includes('赵雨欣')))
  })
  it('returns scheduled interviews and their single completion todo', async () => {
    process.env.NODE_ENV = 'test'
    const store = new LocalRecruitingStore()
    const service = new RecruitingService(store)
    await store.transaction(state => {
      state.interviews.push({
        id: 'scheduled', code: 'IV-SCHEDULED', applicationId: 'application-8821', round: 1,
        stage: 'initial', type: 'technical', title: '初试', status: 'scheduled', participants: [],
        scheduledStartAt: '2026-10-02T01:00:00Z', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
      })
    })
    const dashboard = await service.getDashboardSummary('dept-tech')
    assert.equal(dashboard.pendingInterviews.length, 1)
    assert.equal(dashboard.pendingInterviews[0]!.id, 'scheduled')
    assert.equal(dashboard.pendingInterviews[0]!.candidateName, '王思远')
    assert.equal(dashboard.pendingInterviews[0]!.jobTitle, '高级后端工程师')
    assert.equal(dashboard.pendingInterviews[0]!.application.id, 'application-8821')
    assert.ok(dashboard.todos.some(row => row.id === 'complete-scheduled' && row.path === '/interviews/scheduled'))
    assert.ok(!dashboard.todos.some(row => row.id.startsWith('feedback-') || row.id.startsWith('conclude-')))
  })
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
