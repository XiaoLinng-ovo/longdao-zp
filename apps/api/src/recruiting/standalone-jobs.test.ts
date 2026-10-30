import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RecruitingService } from './service.js'
import { LocalRecruitingStore } from './store.js'

const input = { title: '人事专员', departmentId: 'dept-hr', headcount: 1, employmentType: 'full_time', workMode: 'onsite' }
function fixture() {
  process.env.NODE_ENV = 'test'
  const store = new LocalRecruitingStore()
  return { store, service: new RecruitingService(store) }
}
async function confirmDocuments(service: RecruitingService, id: string) {
  await service.createSpec(id, { title: '人事专员', summary: '人员管理', responsibilities: ['员工档案管理'], requirements: [], skills: [] })
  await service.createJd(id, { language: 'zh-CN', content: '员工档案管理' })
  await service.jobAction(id, 'confirm_spec')
  await service.jobAction(id, 'confirm_jd')
}
const hasCode = (code: string) => (error: unknown) => (error as { code: string }).code === code

describe('standalone job workflow', () => {
  it('creates jobs without demand association without modifying historical demand data', async () => {
    const { store, service } = fixture()
    const before = (await store.read()).recruitmentRequests
    for (const recruitmentRequestId of [undefined, '', '   ']) {
      const job = await service.createJob({ ...input, ...(recruitmentRequestId !== undefined ? { recruitmentRequestId } : {}) })
      assert.equal(job.recruitmentRequestId, '')
      assert.equal(job.status, 'draft')
      assert.equal((await service.getJob(job.id)).title, input.title)
    }
    assert.deepEqual((await store.read()).recruitmentRequests, before)
  })
  it('confirms, publishes, pauses, resumes and closes without a demand record', async () => {
    const { store, service } = fixture()
    const job = await service.createJob(input)
    await assert.rejects(service.jobAction(job.id, 'publish'), hasCode('JOB_DOCUMENT_NOT_CONFIRMED'))
    await confirmDocuments(service, job.id)
    assert.equal((await service.getJob(job.id)).status, 'ready')
    assert.equal((await service.jobAction(job.id, 'publish')).status, 'published')
    assert.equal((await service.jobAction(job.id, 'pause', '暂停招聘')).status, 'paused')
    assert.equal((await service.jobAction(job.id, 'resume')).status, 'published')
    assert.equal((await service.jobAction(job.id, 'close', '招聘结束')).status, 'closed')
    assert.ok((await store.read()).workflowEvents.some(event => event.subjectId === job.id && event.action === 'publish'))
  })
  it('does not weaken validation or historical approval rules', async () => {
    const { store, service } = fixture()
    for (const invalid of [{ title: '' }, { departmentId: '' }, { headcount: 0 }]) {
      await assert.rejects(service.createJob({ ...input, ...invalid }), hasCode('VALIDATION_ERROR'))
    }
    await assert.rejects(service.createJob({ ...input, recruitmentRequestId: 'rr-24017' }), hasCode('RECRUITMENT_REQUEST_NOT_APPROVED'))
    const job = await service.createJob({ ...input, recruitmentRequestId: 'rr-24018' })
    await confirmDocuments(service, job.id)
    await store.transaction(state => { state.recruitmentRequests.find(request => request.id === 'rr-24018')!.status = 'pending_approval' })
    await assert.rejects(service.jobAction(job.id, 'publish'), hasCode('RECRUITMENT_REQUEST_NOT_APPROVED'))
    await store.transaction(state => { state.recruitmentRequests.find(request => request.id === 'rr-24018')!.status = 'converted' })
    assert.equal((await service.jobAction(job.id, 'publish')).status, 'published')
  })
})
