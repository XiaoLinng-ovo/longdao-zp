// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { completeInterview, createLiveInterviewSession, getLiveInterviewTranscription } from './index'
import { getInterview, updateInterviewSchedule, getInterviewQuestions, generateInterviewQuestions, refineInterviewQuestionGroup, uploadLiveInterviewChunk, loadInterviewScheduleData, loadInterviews, type ApiInterview, type ApiInterviewDetail } from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn(), postJson: vi.fn(), patchJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)

describe('Interview API', () => {
  it('times out stalled list responses and permits a fresh retry', async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      getJson.mockImplementation((_path, options) => {
        signals.push(options!.signal as AbortSignal)
        return new Promise(() => {})
      })
      const result = expect(loadInterviews()).rejects.toThrow('读取面试超时')
      await vi.advanceTimersByTimeAsync(20000)
      await result
      expect(signals).toHaveLength(3)
      expect(signals.every((signal) => signal.aborted)).toBe(true)
      getJson.mockResolvedValue({ data: [] } as never)
      expect(await loadInterviews()).toEqual([])
    } finally { vi.useRealTimers() }
  })

  it('bounds loading scheduling options instead of waiting forever', async () => {
    vi.useFakeTimers()
    try {
      getJson.mockImplementation(() => new Promise(() => {}))
      const result = expect(loadInterviewScheduleData()).rejects.toThrow('读取面试安排选项超时')
      await vi.advanceTimersByTimeAsync(20000)
      await result
    } finally { vi.useRealTimers() }
  })

  it('keeps transcription progress requests bounded after merging trial quota notifications', async () => {
    const transcription = { segments: [], pendingCount: 2, retryingCount: 1 }
    getJson.mockResolvedValueOnce({ data: transcription } as never)
    expect(await getLiveInterviewTranscription('local-session')).toEqual(transcription)
    expect(getJson).toHaveBeenLastCalledWith('/interview-live-sessions/local-session/transcription', { signal: expect.any(AbortSignal) })
  })

  it('notifies the trial banner only after creating a live session successfully', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    try {
      const session = { id: 'new-session' }
      vi.mocked(apiClient.postJson).mockResolvedValueOnce({ data: session } as never)
      expect(await createLiveInterviewSession('interview')).toEqual(session)
      expect(dispatch.mock.calls.filter(([event]) => event.type === 'trial-quota-changed')).toHaveLength(1)
      dispatch.mockClear()
      vi.mocked(apiClient.postJson).mockRejectedValueOnce(new Error('quota reached'))
      await expect(createLiveInterviewSession('interview')).rejects.toThrow('quota reached')
      expect(dispatch).not.toHaveBeenCalled()
    } finally { dispatch.mockRestore() }
  })

  it('对话请求只携带分组、历史和取消信号，不携带选题或题库修改目标', async () => {
    const controller = new AbortController()
    const messages = [{ role: 'user' as const, content: '再给我三个新问题' }]
    const result = { questions: [], engine: 'llm', assistantMessage: '1. 新问题', mode: 'discussion', bankUpdated: false }
    vi.mocked(apiClient.postJson).mockResolvedValue({ data: result } as never)
    expect(await refineInterviewQuestionGroup('chat-only', 'hr', messages, controller.signal)).toEqual(result)
    expect(apiClient.postJson).toHaveBeenLastCalledWith('/interviews/chat-only/questions', { refinement: { group: 'hr', messages } }, { signal: controller.signal })
  })
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

  it('sends cancellation as a direct completion without fabricated feedback', async () => {
    vi.mocked(apiClient.postJson).mockResolvedValue({ data: { status: 'cancelled' } } as never)
    await completeInterview('interview-1', 'cancelled')
    expect(apiClient.postJson).toHaveBeenCalledWith('/interviews/interview-1/complete', { outcome: 'cancelled' })
  })

  it('preserves the actual outcome and a genuine zero AI score in list records', async () => {
    getJson.mockImplementation(async (path: string) => ({ data: path === '/interviews' ? [{
      id: 'result-1', code: 'INT-result', applicationId: 'app-1', round: 1,
      status: 'completed', feedbackStatus: 'locked', participants: [], outcome: 'continue', aiScore: 0, aiScoreStatus: 'ready',
      application: { candidateId: 'candidate-1', jobId: 'job-1' },
    }] : [] }) as never)
    expect((await loadInterviews())[0]).toMatchObject({ outcome: 'continue', aiScore: 0, aiScoreStatus: 'ready' })
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
    expect(apiClient.postJson).toHaveBeenCalledWith('/interview-live-sessions/session-a/segments', { audioBase64: 'YXVkaW8=', contentType: 'audio/webm', chunkOffsetMs: 15000 }, { signal: expect.any(AbortSignal), headers: { 'Idempotency-Key': 'audio-fixed-key' } })
  })
  it('sends the streaming words and their audio boundary in the same idempotent write', async () => {
    vi.mocked(apiClient.postJson).mockResolvedValue({ data: [] } as never)
    const transcript = { text: '请完整保留这些已经识别的内容。', endMs: 30000, complete: true }
    await uploadLiveInterviewChunk('session-a', 'YXVkaW8=', 'audio/webm', 15000, 'audio-key', transcript)
    expect(apiClient.postJson).toHaveBeenLastCalledWith('/interview-live-sessions/session-a/segments', { audioBase64: 'YXVkaW8=', contentType: 'audio/webm', chunkOffsetMs: 15000, streamingTranscript: transcript }, { signal: expect.any(AbortSignal), headers: { 'Idempotency-Key': 'audio-key' } })
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
    expect(getJson).toHaveBeenCalledWith('/interviewer-options', { signal: expect.any(AbortSignal) })
  })
})
