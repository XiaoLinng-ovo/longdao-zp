import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RecruitingStoreState } from './types.js'

const now = () => new Date().toISOString()

export function createSeedState(): RecruitingStoreState {
  const timestamp = now()
  return {
    recruitmentRequests: [
      {
        id: 'rr-24018', code: 'REQ-24018', title: '高级后端工程师', departmentId: 'dept-tech', department: '技术中心', requesterId: 'user-demo',
        headcount: 2, employmentType: 'full_time', workMode: 'hybrid', salaryRange: { min: { amount: 35000, currency: 'CNY' }, max: { amount: 50000, currency: 'CNY' } },
        justification: '业务平台扩容，需要补充后端研发力量。', status: 'approved', approval: { status: 'approved', approver: '林晓', actedAt: timestamp }, convertedJobIds: ['job-108'], version: 1, createdAt: timestamp, updatedAt: timestamp
      },
      {
        id: 'rr-24017', code: 'REQ-24017', title: '客户成功经理', departmentId: 'dept-success', department: '客户成功部', requesterId: 'user-demo',
        headcount: 3, employmentType: 'full_time', workMode: 'onsite', salaryRange: { min: { amount: 18000, currency: 'CNY' }, max: { amount: 26000, currency: 'CNY' } },
        justification: '客户规模增长，需要扩充服务团队。', status: 'pending_approval', approval: { status: 'pending', approver: '周宁' }, convertedJobIds: [], version: 1, createdAt: timestamp, updatedAt: timestamp
      },
      {
        id: 'rr-24016', code: 'REQ-24016', title: '品牌设计师', departmentId: 'dept-brand', department: '品牌市场部', requesterId: 'user-demo',
        headcount: 1, employmentType: 'full_time', workMode: 'hybrid', salaryRange: { min: { amount: 16000, currency: 'CNY' }, max: { amount: 22000, currency: 'CNY' } },
        justification: '品牌内容和视觉项目增加。', status: 'draft', approval: { status: 'pending', approver: '陈默' }, convertedJobIds: [], version: 1, createdAt: timestamp, updatedAt: timestamp
      }
    ],
    jobs: [
      { id: 'job-108', code: 'JOB-108', title: '高级后端工程师', departmentId: 'dept-tech', department: '技术中心', recruitmentRequestId: 'rr-24018', headcount: 2, filledCount: 0, employmentType: 'full_time', workMode: 'hybrid', status: 'published', channels: ['官网', 'BOSS直聘', '内推'], spec: { version: 1, title: '高级后端工程师', summary: '负责核心服务设计与研发。', responsibilities: ['负责核心服务设计', '推动工程质量建设'], requirements: [{ label: '本科及以上学历', description: '计算机相关专业优先', required: true }], skills: ['Java', 'Spring Boot', 'PostgreSQL'], confirmed: true, confirmedAt: timestamp }, jd: { version: 1, language: 'zh-CN', content: '负责核心业务服务的设计、开发与持续优化。', generatedBy: 'human', confirmed: true, confirmedAt: timestamp }, version: 1, createdAt: timestamp, updatedAt: timestamp },
      { id: 'job-107', code: 'JOB-107', title: '客户成功经理', departmentId: 'dept-success', department: '客户成功部', recruitmentRequestId: 'rr-24017', headcount: 3, filledCount: 0, employmentType: 'full_time', workMode: 'onsite', status: 'published', channels: ['官网', '猎聘'], version: 1, createdAt: timestamp, updatedAt: timestamp },
      { id: 'job-106', code: 'JOB-106', title: '品牌设计师', departmentId: 'dept-brand', department: '品牌市场部', recruitmentRequestId: 'rr-24016', headcount: 1, filledCount: 0, employmentType: 'full_time', workMode: 'hybrid', status: 'draft', channels: [], version: 1, createdAt: timestamp, updatedAt: timestamp }
    ],
    candidates: [
      { id: 'candidate-8821', code: 'CAN-8821', fullName: '王思远', source: '内推', tags: ['内推', '后端', '高潜'], status: 'active', createdAt: timestamp, updatedAt: timestamp },
      { id: 'candidate-8814', code: 'CAN-8814', fullName: '赵雨欣', source: '猎聘', tags: ['客户成功', '沟通', '高潜'], status: 'active', createdAt: timestamp, updatedAt: timestamp },
      { id: 'candidate-8802', code: 'CAN-8802', fullName: '李哲', source: '官网', tags: ['品牌', '设计'], status: 'active', createdAt: timestamp, updatedAt: timestamp }
    ],
    applications: [
      { id: 'application-8821', code: 'APP-8821', candidateId: 'candidate-8821', jobId: 'job-108', status: 'human_review', score: 92, aiStatus: 'completed', appliedAt: timestamp, updatedAt: timestamp },
      { id: 'application-8814', code: 'APP-8814', candidateId: 'candidate-8814', jobId: 'job-107', status: 'interviewing', score: 86, aiStatus: 'completed', appliedAt: timestamp, updatedAt: timestamp },
      { id: 'application-8802', code: 'APP-8802', candidateId: 'candidate-8802', jobId: 'job-106', status: 'pending_analysis', score: 74, aiStatus: 'pending', appliedAt: timestamp, updatedAt: timestamp }
    ],
    resumes: [],
    analysisTasks: [],
    analysisResults: [],
    jobSpecVersions: [
      {
        jobId: 'job-108', version: 1, title: '高级后端工程师', summary: '负责核心服务设计与研发。', responsibilities: ['负责核心服务设计', '推动工程质量建设'], requirements: [{ label: '本科及以上学历', description: '计算机相关专业优先', required: true }], skills: ['Java', 'Spring Boot', 'PostgreSQL'], confirmed: true, confirmedAt: timestamp, createdAt: timestamp, actorId: 'system'
      }
    ],
    jobDescriptionVersions: [
      {
        jobId: 'job-108', version: 1, language: 'zh-CN', content: '负责核心业务服务的设计、开发与持续优化。', generatedBy: 'human', confirmed: true, confirmedAt: timestamp, createdAt: timestamp, actorId: 'system'
      }
    ],
    offers: [],
    offerVersions: [],
    onboarding: [],
    interviews: [],
    interviewFeedback: [],
    approvalInstances: [],
    approvalSteps: [],
    approvalRecords: [],
    workflowEvents: [],
    candidateTags: ['内推', '后端', '高潜', '客户成功', '沟通', '品牌', '设计'],
    nextRequestNumber: 24019,
    nextJobNumber: 109,
    nextCandidateNumber: 8822,
    nextApplicationNumber: 8822,
    nextInterviewNumber: 501,
    nextOfferNumber: 201
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function migrateState(value: RecruitingStoreState): RecruitingStoreState {
  const seed = createSeedState()
  if (!Array.isArray(value.candidates)) value.candidates = seed.candidates
  if (!Array.isArray(value.candidateTags)) value.candidateTags = seed.candidateTags
  if (!Array.isArray(value.applications)) value.applications = seed.applications
  if (!Array.isArray(value.workflowEvents)) value.workflowEvents = []
  if (!Array.isArray(value.resumes)) value.resumes = []
  if (!Array.isArray(value.analysisTasks)) value.analysisTasks = []
  if (!Array.isArray(value.analysisResults)) value.analysisResults = []
  if (!Array.isArray(value.jobSpecVersions)) {
    value.jobSpecVersions = (value.jobs || []).flatMap((job) => job.spec ? [{ ...job.spec, jobId: job.id, createdAt: job.createdAt || new Date().toISOString(), actorId: 'migration' }] : [])
  }
  if (!Array.isArray(value.jobDescriptionVersions)) {
    value.jobDescriptionVersions = (value.jobs || []).flatMap((job) => job.jd ? [{ ...job.jd, jobId: job.id, createdAt: job.createdAt || new Date().toISOString(), actorId: 'migration' }] : [])
  }
  if (!Array.isArray(value.offers)) value.offers = []
  if (!Array.isArray(value.offerVersions)) value.offerVersions = []
  if (!Array.isArray(value.onboarding)) value.onboarding = []
  if (!Number.isFinite(value.nextOfferNumber)) value.nextOfferNumber = Math.max(0, ...value.offers.map((item) => Number(item.code.replace('OFF-', '')) || 0)) + 1
  if (!Array.isArray(value.interviews)) value.interviews = []
  if (!Array.isArray(value.interviewFeedback)) value.interviewFeedback = []
  if (!Array.isArray(value.approvalInstances)) value.approvalInstances = []
  if (!Array.isArray(value.approvalSteps)) value.approvalSteps = []
  if (!Array.isArray(value.approvalRecords)) value.approvalRecords = []
  if (!Number.isFinite(value.nextCandidateNumber)) value.nextCandidateNumber = seed.nextCandidateNumber
  if (!Number.isFinite(value.nextApplicationNumber)) value.nextApplicationNumber = seed.nextApplicationNumber
  if (!Number.isFinite(value.nextInterviewNumber)) value.nextInterviewNumber = seed.nextInterviewNumber
  return value
}

export class LocalRecruitingStore {
  private state: RecruitingStoreState | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath = process.env.RECRUITING_STORE_PATH || resolve(process.cwd(), '../../data/api-state.json')) {}

  async read(): Promise<RecruitingStoreState> {
    if (this.state) return clone(this.state)
    try {
      this.state = migrateState(JSON.parse(await readFile(this.filePath, 'utf8')) as RecruitingStoreState)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = createSeedState()
      await this.persist(this.state)
    }
    return clone(this.state)
  }

  async transaction<T>(operation: (draft: RecruitingStoreState) => Promise<T> | T): Promise<T> {
    let result!: T
    const next = this.queue.then(async () => {
      const current = await this.read()
      const draft = clone(current)
      result = await operation(draft)
      await this.persist(draft)
      this.state = draft
    })
    this.queue = next.then(() => undefined, () => undefined)
    await next
    return result
  }

  private async persist(state: RecruitingStoreState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.${process.pid}.tmp`
    await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8')
    await rename(tempPath, this.filePath)
  }

  static eventId(): string { return randomUUID() }
  static timestamp(): string { return now() }
}
