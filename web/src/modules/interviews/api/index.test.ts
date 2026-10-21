// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { getInterview, updateInterviewSchedule, getInterviewQuestions, generateInterviewQuestions, uploadLiveInterviewChunk, loadInterviewScheduleData, loadInterviews, type ApiInterview, type ApiInterviewDetail } from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn(), postJson: vi.fn(), patchJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)

describe('Interview API', () => {
  function interview(id: string, scheduledStartAt?: string): ApiInterview {
    return {
      id, code: id, applicationId: 'app-1', round: 1, type: 'technical', title: 'Interview',
      status: 'scheduled', scheduledStartAt, participants: [], feedbackStatus: 'pending',
      application: { id: 'app-1', code: 'APP-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'interviewing' },
      createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    }
  }

  it('sorts by full interview time descending, keeps ties stable and puts missing or invalid times last', async () => {
    const interviews = [
      interview('older', '2025-12-31T23:00:00Z'),
      interview('unscheduled'),
      interview('morning', '2026-10-19T10:00:00+08:00'),
      interview('invalid', 'invalid-date'),
      interview('afternoon', '2026-10-19T14:00:00+08:00'),
      interview('same-time', '2026-10-19T06:00:00Z'),
      interview('next-year', '2027-01-01T00:00:00Z'),
    ]
    const originalIds = interviews.map((row) => row.id)
    getJson.mockImplementation(async (path: string) => ({ data: path === '/interviews' ? interviews : [] }) as never)

    expect((await loadInterviews()).map((row) => row.entityId)).toEqual([
      'next-year', 'afternoon', 'same-time', 'morning', 'older', 'unscheduled', 'invalid',
    ])
    expect(interviews.map((row) => row.id)).toEqual(originalIds)
  })

  it('reorders refreshed interviews after a schedule change regardless of status or response order', async () => {
    const interviews = [
      interview('first', '2026-10-19T10:00:00+08:00'),
      { ...interview('second', '2026-10-19T11:00:00+08:00'), status: 'completed' as const },
    ]
    getJson.mockImplementation(async (path: string) => ({ data: path === '/interviews' ? interviews : [] }) as never)
    expect((await loadInterviews()).map((row) => row.entityId)).toEqual(['second', 'first'])

    interviews[0]!.scheduledStartAt = '2026-10-19T14:00:00+08:00'
    expect((await loadInterviews()).map((row) => row.entityId)).toEqual(['first', 'second'])
  })

  it('patches an existing interview and transmits explicit clearing values', async () => {
    vi.mocked(apiClient.patchJson).mockResolvedValue({ data: { location: 'B会议室' } } as never)
    const patch = { location: 'B会议室', scheduledEndAt: null, meetingUrl: null }
    expect(await updateInterviewSchedule('interview-1', patch)).toEqual({ location: 'B会议室' })
    expect(apiClient.patchJson).toHaveBeenCalledWith('/interviews/interview-1', patch)
  })
  it('reuses the chunk identity for safe audio retries', async () => {
    vi.mocked(apiClient.postJson).mockResolvedValue({ data: [] } as never)
    await uploadLiveInterviewChunk('session-a', 'YXVkaW8=', 'audio/webm', 15000, 'audio-fixed-key')
    expect(apiClient.postJson).toHaveBeenCalledWith('/interview-live-sessions/session-a/segments', { audioBase64: 'YXVkaW8=', contentType: 'audio/webm', chunkOffsetMs: 15000 }, { headers: { 'Idempotency-Key': 'audio-fixed-key' } })
  })
  it('sends the streaming words and their audio boundary in the same idempotent write', async () => {
    vi.mocked(apiClient.postJson).mockResolvedValue({ data: [] } as never)
    const transcript = { text: '请完整保留这些已经识别的内容。', endMs: 30000, complete: true }
    await uploadLiveInterviewChunk('session-a', 'YXVkaW8=', 'audio/webm', 15000, 'audio-key', transcript)
    expect(apiClient.postJson).toHaveBeenLastCalledWith('/interview-live-sessions/session-a/segments', { audioBase64: 'YXVkaW8=', contentType: 'audio/webm', chunkOffsetMs: 15000, streamingTranscript: transcript }, { headers: { 'Idempotency-Key': 'audio-key' } })
  })
  it('透传题库读取和生成的取消信号', async () => {
    const controller = new AbortController()
    vi.mocked(apiClient.postJson).mockResolvedValue({ data: { questions: [], engine: 'llm' } } as never)
    getJson.mockResolvedValue({ data: null } as never)
    await getInterviewQuestions('signal-test', controller.signal)
    await generateInterviewQuestions('signal-test', 10, true, controller.signal)
    expect(getJson).toHaveBeenCalledWith('/interviews/signal-test/questions', { signal: controller.signal })
    expect(apiClient.postJson).toHaveBeenCalledWith('/interviews/signal-test/questions', { questionCount: 10, includeCommonQuestions: true }, { signal: controller.signal })
  })
  it('requests 10 resume questions plus AI-generated capability groups by default', async () => {
    vi.mocked(apiClient.postJson).mockResolvedValue({ data: { questions: [], engine: 'llm' } } as never)
    await generateInterviewQuestions('interview-bank')
    expect(apiClient.postJson).toHaveBeenCalledWith('/interviews/interview-bank/questions', { questionCount: 10, includeCommonQuestions: true })
  })
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
    expect(rows[0]?.interviewerOptions).toEqual([{ id: interviewerId, name: '林晓' }])
  })

  it('loads active interviewer options for the schedule form', async () => {
    getJson.mockImplementation((path: string) => {
      if (path === '/applications') return Promise.resolve({ ok: true, requestId: 'test', data: [] } as never)
      if (path === '/candidates') return Promise.resolve({ ok: true, requestId: 'test', data: [] } as never)
      if (path === '/jobs') return Promise.resolve({ ok: true, requestId: 'test', data: [] } as never)
      if (path === '/interviewer-options') {
        return Promise.resolve({
          ok: true,
          requestId: 'test',
          data: [{ id: '77777777-7777-4777-8777-777777777777', displayName: '林晓', email: 'lin@example.com' }],
        } as never)
      }
      throw new Error(`unexpected ${path}`)
    })

    const result = await loadInterviewScheduleData()

    expect(result.interviewers).toEqual([{ id: '77777777-7777-4777-8777-777777777777', displayName: '林晓', email: 'lin@example.com' }])
    expect(getJson).toHaveBeenCalledWith('/interviewer-options')
  })
})
