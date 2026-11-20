import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { filterReportState, reportChannel, reportFilterOptions } from './report-filters.js'
import { createSeedState } from './store.js'

function fixture() {
  const state = createSeedState()
  state.candidates = [
    { id: 'candidate-a', code: 'CAN-A', fullName: '隔离测试甲', source: 'resume-import:1', status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
    { id: 'candidate-b', code: 'CAN-B', fullName: '隔离测试乙', source: 'referral', status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
  ]
  state.jobs = state.jobs.filter(job => job.id === 'job-108' || job.id === 'job-107')
  state.applications = [
    { id: 'application-a', code: 'APP-A', candidateId: 'candidate-a', jobId: 'job-108', status: 'interviewing', source: 'resume-import:1', aiStatus: 'completed', appliedAt: '2026-11-01T16:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' },
    { id: 'application-b', code: 'APP-B', candidateId: 'candidate-b', jobId: 'job-107', status: 'human_review', source: 'referral', aiStatus: 'completed', appliedAt: '2026-11-02T16:00:00.000Z', updatedAt: '2026-11-02T16:00:00.000Z' },
  ]
  state.interviews = state.interviews.filter(item => item.applicationId === 'application-a' || item.applicationId === 'application-b')
  state.interviewFeedback = state.interviewFeedback.filter(item => state.interviews.some(interview => interview.id === item.interviewId))
  state.offers = state.offers.filter(item => item.applicationId === 'application-a' || item.applicationId === 'application-b')
  return state
}

describe('招聘报表筛选', () => {
  it('组合日期、岗位、渠道和申请状态筛选，并保留关联记录', () => {
    const result = filterReportState(fixture(), { from: '2026-11-02', to: '2026-11-02', jobId: 'job-108', channel: '批量导入', status: 'interviewing' })
    assert.deepEqual(result.applications.map(item => item.id), ['application-a'])
    assert.deepEqual(result.jobs.map(item => item.id), ['job-108'])
    assert.ok(result.interviews.every(item => item.applicationId === 'application-a'))
    assert.ok(result.offers.every(item => item.applicationId === 'application-a'))
  })

  it('按北京时间日期边界包含整日并排除次日零点', () => {
    const result = filterReportState(fixture(), { from: '2026-11-02', to: '2026-11-02' })
    assert.deepEqual(result.applications.map(item => item.id), ['application-a'])
  })

  it('拒绝不存在的日期和倒置的日期范围', () => {
    assert.throws(() => filterReportState(fixture(), { from: '2026-02-30' }), /有效的统计日期/u)
    assert.throws(() => filterReportState(fixture(), { from: '2026-11-03', to: '2026-11-02' }), /结束日期不能早于开始日期/u)
  })

  it('将批量导入内部编码归一化为中文渠道选项', () => {
    assert.equal(reportChannel('resume-import:1'), '批量导入')
    assert.ok(reportFilterOptions(fixture()).channels.includes('批量导入'))
  })
})
