import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RecruitingService } from './service.js'
import { LocalRecruitingStore } from './store.js'

function fixture() {
  process.env.NODE_ENV = 'test'
  const store = new LocalRecruitingStore()
  return { store, service: new RecruitingService(store) }
}
test('deleting an unused job removes document history, retains people and records an audit event', async () => {
  const { store, service } = fixture()
  const job = await service.createJob({ title: '待删除测试岗位', departmentId: 'dept-hr', headcount: 1, employmentType: 'full_time', workMode: 'onsite', recruitmentRequestId: 'rr-24018' })
  await service.createSpec(job.id, { title: job.title, summary: '摘要', responsibilities: [], requirements: [], skills: [] })
  await service.createJd(job.id, { language: 'zh-CN', content: '岗位描述' })
  const before = await store.read()
  await service.deleteJob(job.id, 'deletion-tester')
  const after = await store.read()
  assert.ok(!after.jobs.some(item => item.id === job.id))
  assert.ok(!after.jobSpecVersions.some(item => item.jobId === job.id))
  assert.ok(!after.jobDescriptionVersions.some(item => item.jobId === job.id))
  assert.ok(!after.recruitmentRequests.some(item => item.convertedJobIds.includes(job.id)))
  for (const key of ['candidates', 'resumes', 'applications', 'interviews', 'offers', 'onboarding'] as const) assert.deepEqual(after[key], before[key])
  assert.ok(after.workflowEvents.some(event => event.subjectId === job.id && event.action === 'delete' && event.actorId === 'deletion-tester'))
  await assert.rejects(service.getJob(job.id))
  await assert.rejects(service.deleteJob(job.id))
})
test('a job with applications cannot be deleted, even if the application is rejected', async () => {
  const { store, service } = fixture()
  await store.transaction(state => { state.applications.find(item => item.jobId === 'job-108')!.status = 'rejected' })
  const before = await store.read()
  await assert.rejects(service.deleteJob('job-108'), (error: any) => error.code === 'JOB_IN_USE' && error.status === 409)
  assert.deepEqual(await store.read(), before)
})
test('related job records include rejected applications and do not include other jobs', async () => {
  const { store, service } = fixture()
  await store.transaction(state => { state.applications.find(item => item.jobId === 'job-108')!.status = 'rejected' })
  const state = await store.read()
  const records = await service.listJobRelatedRecords('job-108')
  const expected = state.applications.filter(item => item.jobId === 'job-108')
  assert.equal(records.length, expected.length)
  assert.ok(records.some(record => record.status === 'rejected'))
  for (const record of records) {
    const application = expected.find(item => item.id === record.id)!
    assert.equal(record.candidateId, application.candidateId)
    assert.equal(record.applicationId, application.id)
    assert.equal(record.kind, 'application')
  }
  await assert.rejects(service.listJobRelatedRecords('missing-job'))
})
