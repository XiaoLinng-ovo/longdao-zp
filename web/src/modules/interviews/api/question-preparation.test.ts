import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { questionPreparationFailureLabel, waitForPreparedInterviewQuestions } from './question-preparation'
import type { InterviewQuestionSet } from './index'
vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn(), postJson: vi.fn() } }))
const bank = { questions: [{ question: '招聘问题' }], engine: 'llm' } as InterviewQuestionSet
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks() })
afterEach(() => { vi.useRealTimers() })
describe('prepared interview questions', () => {
  it('labels model groups and non-model failures separately', () => {
    expect(questionPreparationFailureLabel({ stage: 'question_generation', group: 'hr', code: 'MODEL_HTTP_ERROR' })).toBe('HR题组生成失败')
    expect(questionPreparationFailureLabel({ stage: 'rubrics', code: 'PREPARATION_FAILED' })).toBe('评价表准备失败')
    expect(questionPreparationFailureLabel({ stage: 'context', code: 'INVALID_INPUT' })).toBe('读取面试资料失败')
    expect(questionPreparationFailureLabel({ stage: 'publish', code: 'PREPARATION_FAILED' })).toBe('保存题库失败')
  })
  it('reads a ready bank without posting another generation request', async () => {
    vi.mocked(apiClient.getJson).mockResolvedValue({ data: { status: 'ready', completedGroups: [] } } as never)
    const loadSaved = vi.fn(async () => bank)
    expect(await waitForPreparedInterviewQuestions('int-1', { signal: new AbortController().signal, loadSaved })).toBe(bank)
    expect(loadSaved).toHaveBeenCalledOnce(); expect(apiClient.postJson).not.toHaveBeenCalled()
  })
  it('follows queued/running progress until completion without duplicate POSTs', async () => {
    vi.mocked(apiClient.getJson).mockResolvedValueOnce({ data: { status: 'queued', completedGroups: [] } } as never)
      .mockResolvedValueOnce({ data: { status: 'generating', completedGroups: ['ai'] } } as never)
      .mockResolvedValueOnce({ data: { status: 'ready', completedGroups: ['ai', 'hr', 'department'] } } as never)
    const onState = vi.fn()
    const result = waitForPreparedInterviewQuestions('int-1', { signal: new AbortController().signal, loadSaved: async () => bank, onState })
    await vi.advanceTimersByTimeAsync(4000)
    expect(await result).toBe(bank); expect(onState).toHaveBeenCalledTimes(3)
    expect(apiClient.postJson).not.toHaveBeenCalled()
  })
  it('queues a legacy interview once and then only polls', async () => {
    vi.mocked(apiClient.getJson).mockResolvedValueOnce({ data: { status: 'not_started', completedGroups: [] } } as never)
      .mockResolvedValueOnce({ data: { status: 'ready', completedGroups: [] } } as never)
    vi.mocked(apiClient.postJson).mockResolvedValue({ data: { status: 'queued', completedGroups: [] } } as never)
    const result = waitForPreparedInterviewQuestions('legacy', { signal: new AbortController().signal, loadSaved: async () => bank })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await result).toBe(bank); expect(apiClient.postJson).toHaveBeenCalledTimes(1)
  })
  it('aborts only local polling and leaves the persisted task untouched', async () => {
    vi.mocked(apiClient.getJson).mockResolvedValue({ data: { status: 'generating', completedGroups: [] } } as never)
    const controller = new AbortController()
    const result = waitForPreparedInterviewQuestions('int-1', { signal: controller.signal, loadSaved: async () => bank })
    const rejected = expect(result).rejects.toThrow('leave')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(new Error('leave')); await rejected
    await vi.advanceTimersByTimeAsync(10000)
    expect(apiClient.getJson).toHaveBeenCalledTimes(1); expect(apiClient.postJson).not.toHaveBeenCalled()
  })
  it('does not automatically retry failures on every page visit', async () => {
    vi.mocked(apiClient.getJson).mockResolvedValue({ data: { status: 'failed', completedGroups: [], error: '企业模型未配置' } } as never)
    await expect(waitForPreparedInterviewQuestions('int-1', { signal: new AbortController().signal, loadSaved: async () => bank })).rejects.toThrow('企业模型未配置')
    expect(apiClient.postJson).not.toHaveBeenCalled()
  })
  it('explicit retry requests one task and reuses the resulting saved bank', async () => {
    vi.mocked(apiClient.getJson).mockResolvedValue({ data: { status: 'failed', completedGroups: [] } } as never)
    vi.mocked(apiClient.postJson).mockResolvedValue({ data: { status: 'ready', completedGroups: [] } } as never)
    expect(await waitForPreparedInterviewQuestions('int-1', { signal: new AbortController().signal, retry: true, loadSaved: async () => bank })).toBe(bank)
    expect(apiClient.postJson).toHaveBeenCalledOnce()
  })
  it('never starts preparing completed/cancelled interviews', async () => {
    vi.mocked(apiClient.getJson).mockResolvedValue({ data: { status: 'cancelled', completedGroups: [] } } as never)
    await expect(waitForPreparedInterviewQuestions('int-1', { signal: new AbortController().signal, loadSaved: async () => bank })).rejects.toThrow('已结束或取消')
    expect(apiClient.postJson).not.toHaveBeenCalled()
  })
})
