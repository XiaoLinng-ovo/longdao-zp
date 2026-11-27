import assert from 'node:assert/strict'
import { it } from 'node:test'
import { LocalRecruitingStore } from './store.js'
import { RecruitingService } from './service.js'
import type { NormalizedRecruitingRepository } from './repositories/postgres-repository.js'

it('persists stages, clears initial salary and retains prior versions after a final pass', async () => {
  process.env.NODE_ENV = 'test'
  const store = new LocalRecruitingStore()
  const service = new RecruitingService(store)
  const applicationId = 'application-8814'
  const final = await service.createInterview({ applicationId, round: 2, title: 'Final', participants: [{ userId: 'user-demo', role: 'interviewer' }] })
  await service.completeInterview(final.id, 'offer')
  const input = { applicationId, positionTitle: '工程师', departmentId: 'dept-success', employmentType: 'full_time',
    baseSalary: { amount: 10000, currency: 'CNY' }, probationSalary: { amount: 8000, currency: 'CNY' },
    templateFields: { probationDuration: '3个月', probationSalaryMonths: '1' }, content: '<p>原约定</p>' }
  const offer = await service.createOffer(input)
  const before = await service.getOffer(offer.id)
  assert.equal(before.versions[0]!.templateFields?.formalSalaryStartMonth, '2')
  await assert.rejects(service.createOffer(input))
  await service.updateOffer(offer.id, { probationSalary: null, templateFields: { probationSalaryMonths: '0', formalSalaryStartMonth: '1' } })
  const after = await service.getOffer(offer.id)
  const current = after.versions.find(item => item.id === after.currentVersionId)!
  assert.equal(current.compensation.probationSalary, undefined)
  assert.equal(Object.hasOwn(current.compensation, 'probationSalary'), false)
  assert.equal(current.templateFields?.probationSalaryMonths, '0')
  assert.equal(current.templateFields?.probationDuration, '3个月')
  assert.equal(current.templateFields?.formalSalaryStartMonth, '1')
  assert.equal(after.versions.find(item => item.id === before.currentVersionId)!.compensation.probationSalary?.amount, 8000)
  assert.equal(after.versions.find(item => item.id === before.currentVersionId)!.content, '<p>原约定</p>')
  await assert.rejects(service.updateOffer(offer.id, { templateFields: { probationSalaryMonths: '1', formalSalaryStartMonth: '4' } }), { code: 'OFFER_SALARY_INVALID' })
  assert.equal((await service.getOffer(offer.id)).versions.length, 2)
})

it('passes normalized salary fields and removes initial salary in repository revisions', async () => {
  const previous = { id: 'version-1', employmentType: 'full_time', positionTitle: 'Engineer', departmentId: 'department-1',
    templateFields: { probationDuration: '3个月', probationSalaryMonths: '1', formalSalaryStartMonth: '2' },
    compensation: { baseSalary: { amount: 10000, currency: 'CNY' }, probationSalary: { amount: 8000, currency: 'CNY' } },
    benefits: [], materials: [], content: '<p>Original terms</p>' }
  const original = structuredClone(previous)
  const offer = { id: 'offer-1', applicationId: 'application-1', status: 'draft', currentVersionId: 'version-1',
    approvalStatus: 'pending', version: 1, createdAt: '2026-11-27T00:00:00Z', updatedAt: '2026-11-27T00:00:00Z' }
  let revision: Record<string, unknown> | undefined
  const repository = {
    async getOffer() { return offer },
    async getOnboardingByOfferId() { return null },
    async listOfferVersions() { return [previous] },
    async reviseOffer(input: Record<string, unknown>, expectedVersionId: string, expectedVersion: number) {
      assert.equal(expectedVersionId, 'version-1')
      assert.equal(expectedVersion, 1)
      revision = structuredClone(input)
      return { ...offer, currentVersionId: 'version-2', version: 2 }
    },
  } as unknown as NormalizedRecruitingRepository
  const service = new RecruitingService(undefined, undefined, undefined, repository)
  await service.updateOffer(offer.id, { probationSalary: null, templateFields: { probationSalaryMonths: '0', formalSalaryStartMonth: '1' } }, 'actor-1', 1)
  assert.ok(revision)
  assert.deepEqual(revision.templateFields, { probationDuration: '3个月', probationSalaryMonths: '0', formalSalaryStartMonth: '1' })
  assert.deepEqual(JSON.parse(JSON.stringify(revision.compensation)), { baseSalary: { amount: 10000, currency: 'CNY' } })
  assert.equal(revision.content, original.content)
  assert.deepEqual(previous, original)
})
