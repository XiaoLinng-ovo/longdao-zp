import { describe, expect, it } from 'vitest'
import { actionLabel, applicationOptionLabel, employmentTypeLabel, statusLabel, workModeLabel } from './labels'
import { recommendationLabel, humanReviewStatusLabel } from '../../modules/candidates/labels'
import { jobStatusLabel } from '../../modules/jobs/workflow'
import { requisitionStatusLabel } from '../../modules/requisitions/workflow'

describe('业务字段中文展示', () => {
  it.each(['screening', 'submitted', 'locked', 'no_show', 'clean', 'reserved'])('映射已知状态 %s', value => {
    expect(statusLabel(value)).toMatch(/\p{Script=Han}/u)
    expect(statusLabel(value)).not.toBe(value)
  })
  it('未知枚举不会回退展示内部值', () => {
    const value = 'future_internal_code:123'
    for (const format of [statusLabel, actionLabel, employmentTypeLabel, workModeLabel, recommendationLabel, humanReviewStatusLabel, jobStatusLabel, requisitionStatusLabel]) {
      expect(format(value)).toMatch(/\p{Script=Han}/u)
      expect(format(value)).not.toContain(value)
    }
    expect(statusLabel()).toBe('-')
    expect(actionLabel('create')).toBe('创建')
  })
  it('申请选项缺少名称时不显示内部主键', () => {
    const app = { id: 'internal-app', code: 'internal-code', candidateId: 'internal-candidate', jobId: 'internal-job' }
    expect(applicationOptionLabel(app)).toBe('申请信息待补全')
    expect(applicationOptionLabel({ ...app, candidateName: '张三' })).toBe('张三 · 岗位待补全')
    expect(applicationOptionLabel({ ...app, jobTitle: '工程师' })).toBe('候选人待补全 · 工程师')
    expect(applicationOptionLabel({ ...app, candidateName: '张三', jobTitle: '工程师' })).toBe('张三 · 工程师')
  })
})
