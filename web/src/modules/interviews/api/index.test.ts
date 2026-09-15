// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { getInterview, type ApiInterviewDetail } from './index'

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
})
