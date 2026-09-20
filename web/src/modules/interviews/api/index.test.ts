// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { getInterview, loadInterviews, type ApiInterviewDetail } from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)

describe('Interview API', () => {
  it('读取面试详情', async () => {
    getJson.mockResolvedValue({
      ok: true,
      requestId: 'test',
      data: {
        id: 'interview-1',
        code: 'INT-1',
        applicationId: 'app-1',
        round: 1,
        type: 'technical',
        title: '技术面',
        status: 'scheduled',
        participants: [{ userId: 'interviewer-1', name: '林晓', role: 'interviewer', required: true }],
        feedbackStatus: 'pending',
        application: { id: 'app-1', code: 'APP-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'interview' },
        createdAt: '2026-09-14T00:00:00Z',
        updatedAt: '2026-09-14T00:00:00Z',
        feedback: [],
      } as ApiInterviewDetail,
    } as never)

    const detail = await getInterview('interview-1')
    expect(getJson).toHaveBeenCalledWith('/interviews/interview-1')
    expect(detail.code).toBe('INT-1')
    expect(detail.feedback).toEqual([])
  })

  it('保留面试官用户 ID，展示时仍使用姓名', async () => {
    const interviewerId = '77777777-7777-4777-8777-777777777777'
    getJson.mockImplementation((path: string) => {
      if (path === '/interviews') {
        return Promise.resolve({
          ok: true,
          requestId: 'test',
          data: [{
            id: 'interview-1',
            code: 'INT-1',
            applicationId: 'app-1',
            round: 1,
            type: 'technical',
            title: '技术面',
            status: 'scheduled',
            participants: [{ userId: interviewerId, name: '林晓', role: 'interviewer', required: true }],
            feedbackStatus: 'pending',
            application: { id: 'app-1', code: 'APP-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'interview' },
            createdAt: '2026-09-14T00:00:00Z',
            updatedAt: '2026-09-14T00:00:00Z',
          }],
        } as never)
      }
      if (path === '/candidates') {
        return Promise.resolve({ ok: true, requestId: 'test', data: [{ id: 'candidate-1', code: 'CAN-1', fullName: '王思远' }] } as never)
      }
      if (path === '/jobs') {
        return Promise.resolve({ ok: true, requestId: 'test', data: [{ id: 'job-1', title: '高级后端工程师' }] } as never)
      }
      throw new Error(`unexpected ${path}`)
    })

    const rows = await loadInterviews()

    expect(rows[0]?.interviewers).toEqual(['林晓'])
    expect(rows[0]?.interviewerIds).toEqual([interviewerId])
  })
})
