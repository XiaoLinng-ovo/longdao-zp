import { apiClient } from '../../../shared/api'
import type { InterviewQuestionSet } from './index'

export interface QuestionPreparation {
  status: 'not_started' | 'queued' | 'generating' | 'ready' | 'failed' | 'cancelled'
  completedGroups: Array<'ai' | 'hr' | 'department' | 'boss'>
  error?: string
  failure?: {
    stage: 'rubrics' | 'context' | 'question_generation' | 'publish'; group?: 'ai' | 'hr' | 'department' | 'boss'; code: string
    diagnosticId?: string; httpStatus?: number; reason?: 'timeout' | 'network'; retryable?: boolean; durationMs?: number; model?: string
  }
  attempts?: number
  nextRetryAt?: string
  rubricsStatus?: 'queued' | 'ready'
  materialsChanged?: boolean
  updatedAt?: string
}
const groupLabels = { ai: 'AI', hr: 'HR', department: '用人部门', boss: 'BOSS' } as const
export function questionPreparationFailureLabel(failure: NonNullable<QuestionPreparation['failure']>): string {
  if (failure.group) return `${groupLabels[failure.group]}题组生成失败`
  if (failure.stage === 'rubrics') return '评价表准备失败'
  if (failure.stage === 'context') return '读取面试资料失败'
  if (failure.stage === 'publish') return '保存题库失败'
  return '面试题生成失败'
}
export async function getQuestionPreparation(id: string, signal?: AbortSignal, includeMaterials = false): Promise<QuestionPreparation> {
  return (await apiClient.getJson<QuestionPreparation>('/interviews/' + id + '/question-preparation' + (includeMaterials ? '?materials=1' : ''), { signal })).data
}
export async function prepareInterviewQuestions(id: string, signal?: AbortSignal): Promise<QuestionPreparation> {
  return (await apiClient.postJson<QuestionPreparation>('/interviews/' + id + '/question-preparation', {}, { signal })).data
}
function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 2000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort() }
  })
}
/** Aborting stops this page's wait, never the persisted background generation. */
export async function waitForPreparedInterviewQuestions(id: string, options: {
  signal: AbortSignal
  retry?: boolean
  loadSaved: () => Promise<InterviewQuestionSet | null>
  onState?: (state: QuestionPreparation) => void
}): Promise<InterviewQuestionSet> {
  let state = await getQuestionPreparation(id, options.signal)
  if (state.status === 'not_started' || (state.status === 'failed' && options.retry)) {
    state = await prepareInterviewQuestions(id, options.signal)
  }
  for (;;) {
    options.signal.throwIfAborted()
    options.onState?.(state)
    if (state.status === 'failed') throw new Error(state.error || '面试表准备失败，请点击重试准备。')
    if (state.status === 'cancelled') throw new Error('该面试已结束或取消，不再自动准备面试表。')
    if (state.status === 'ready') {
      const saved = await options.loadSaved()
      if (!saved?.questions.length) throw new Error('尚未读取到已准备的面试表，请重新加载。')
      return saved
    }
    if (!['queued', 'generating'].includes(state.status)) throw new Error('面试表准备状态暂时不可用，请重试。')
    await delay(options.signal)
    state = await getQuestionPreparation(id, options.signal)
  }
}
