import { describe, expect, it } from 'vitest'
import { jobPublishHint, jobActionsFor } from './workflow'

describe('独立岗位发布提示', () => {
  const ready = { status: 'ready', spec: { confirmed: true }, jd: { confirmed: true } }
  it('无需求关联，文档已确认即可发布', () => {
    expect(jobPublishHint(ready)).toBe('说明书和 JD 已就绪，可发布岗位。')
    expect(jobActionsFor(ready)).toContain('publish')
  })
  it('仍要求确认文档，并提示历史关联需求的审批保护', () => {
    expect(jobPublishHint({ status: 'draft' })).toContain('说明书尚未确认')
    expect(jobPublishHint({ ...ready, jd: { confirmed: false } })).toContain('JD 尚未确认')
    expect(jobPublishHint({ ...ready, recruitmentRequestId: 'historical-request' })).toContain('历史关联需求')
    expect(jobPublishHint({ ...ready, status: 'closed' })).toContain('不能发布')
  })
})
