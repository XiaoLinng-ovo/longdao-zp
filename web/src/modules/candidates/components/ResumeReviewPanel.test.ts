// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import ResumeReviewPanel from './ResumeReviewPanel.vue'
import { updateResumeReview } from '../api'
import type { ResumeScoreSummary } from '../../../shared/types/recruiting'
vi.mock('../api', () => ({ updateResumeReview: vi.fn() }))
let app: App | undefined
let root: HTMLDivElement | undefined
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks() })
async function mount(overrides: Partial<ResumeScoreSummary> = {}, busy = false) {
  root = document.createElement('div'); document.body.append(root)
  const summary: ResumeScoreSummary = { resultId: 'result', talentPool: false, history: [], evidence: [], strengths: [], risks: [], ...overrides }
  app = createApp(ResumeReviewPanel, { summary, canEdit: true, applicationStatus: 'human_review', busy })
  app.mount(root); await nextTick(); return root
}
describe('unavailable AI score', () => {
  it('shows the missing-score reason without pretending it is zero or waiting only for human review', async () => {
    const root = await mount({ analysisEngine: 'deterministic-rules', risks: ['岗位未提供任职要求，综合评分暂不可用'] })
    expect(root.textContent).toContain('AI 评分未生成（不是 0 分）')
    expect(root.textContent).toContain('岗位未提供任职要求')
    expect(root.querySelector('.final-score')?.textContent).toContain('待 AI 评分')
    expect(root.querySelector('.ai-advice')?.textContent).not.toContain('待人工评分')
    expect(root.querySelector<HTMLButtonElement>('.pass-button')?.disabled).toBe(true)
  })
  it('keeps a real zero score distinct from missing data', async () => {
    const root = await mount({ aiScore: 0, analysisEngine: 'llm-suggestion' })
    expect(root.querySelector('.ai-score-unavailable')).toBeNull()
    expect(root.querySelector('.final-score')?.textContent).toContain('0/100')
    expect(root.querySelector('.ai-advice')?.textContent).toContain('建议淘汰')
    expect(root.querySelector<HTMLButtonElement>('.eliminate-button')?.disabled).toBe(false)
  })
  it('shows in-progress status, not an old missing-rule reason', async () => {
    const root = await mount({ risks: ['旧报告缺岗位要求'] }, true)
    expect(root.querySelector('.ai-score-unavailable')?.textContent).toContain('AI 评分生成中')
    expect(root.querySelector('.ai-score-unavailable')?.textContent).not.toContain('旧报告')
  })
})

describe('AI advice with manual screening decisions', () => {
  it.each([79.99, 80, 80.01])('preserves AI advice for %s without restricting either manual decision', async (aiScore) => {
    const root = await mount({ aiScore, humanScore: 100, finalScore: 99, history: [{ humanScore: 100, finalScore: 99, comment: '旧人工分', actorId: 'u1', updatedAt: '' }] })
    expect(root.textContent).not.toContain('人工评分')
    expect(root.textContent).not.toContain('最终得分')
    expect(root.querySelector('.final-score')?.textContent).toContain(String(aiScore))
    expect(root.querySelector<HTMLButtonElement>('.pass-button')?.disabled).toBe(false)
    expect(root.querySelector<HTMLButtonElement>('.eliminate-button')?.disabled).toBe(false)
    expect(root.querySelector('.ai-advice')?.textContent).toContain(aiScore < 80 ? '建议淘汰' : '进入初试')
  })
})

it.each([0, 27, 79.99])('confirms manual pass for AI score %s without submitting a replacement score', async (aiScore) => {
  const root = await mount({ aiScore })
  vi.mocked(updateResumeReview).mockResolvedValue({} as never)
  root.querySelector<HTMLButtonElement>('.pass-button')!.click()
  await nextTick()
  expect(root.querySelector('.decision-confirm .warning')?.textContent).toContain('人工确认通过')
  const reason = root.querySelector<HTMLTextAreaElement>('textarea')!
  reason.value = '已核实经验，邀请初试'
  reason.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  root.querySelector<HTMLButtonElement>('.decision-confirm .btn-primary')!.click()
  for (let i = 0; i < 5; i++) { await Promise.resolve(); await nextTick() }
  expect(updateResumeReview).toHaveBeenCalledTimes(1)
  expect(updateResumeReview).toHaveBeenCalledWith('result', { decision: 'passed', comment: '已核实经验，邀请初试' })
  expect(root.querySelector('.decision-confirm')).toBeNull()
  expect(root.textContent).toContain('已通过，进入初试待邀约')
  expect(root.querySelector('.ai-advice')?.textContent).toContain('建议淘汰')
})

it.each([80, 100])('allows manual elimination despite AI score %s recommending pass', async (aiScore) => {
  const root = await mount({ aiScore })
  vi.mocked(updateResumeReview).mockResolvedValue({} as never)
  root.querySelector<HTMLButtonElement>('.eliminate-button')!.click()
  await nextTick()
  expect(root.querySelector('.decision-confirm .warning')?.textContent).toContain('人工确认淘汰')
  root.querySelector<HTMLButtonElement>('.decision-confirm .btn-primary')!.click()
  for (let i = 0; i < 5; i++) { await Promise.resolve(); await nextTick() }
  expect(updateResumeReview).toHaveBeenCalledWith('result', { decision: 'eliminated', comment: '' })
  expect(root.querySelector('.decision-confirm')).toBeNull()
})

 it('disables screening while reanalysis is busy even when a historical high AI score is displayed', async () => {
   const root = await mount({ aiScore: 90 }, true)
   expect(root.querySelector('.ai-advice')?.textContent).toContain('AI 评分生成中')
   expect(root.querySelector<HTMLButtonElement>('.pass-button')?.disabled).toBe(true)
   expect(root.querySelector<HTMLButtonElement>('.eliminate-button')?.disabled).toBe(true)
 })

it('shows the requested pending-interview wording after the score in pass confirmation', async () => {
  const root = await mount({ aiScore: 81.6 })
  root.querySelector<HTMLButtonElement>('.pass-button')!.click()
  await nextTick()
  const confirmation = root.querySelector('.decision-confirm')!
  expect(confirmation.querySelector('p')?.textContent).toBe('AI 评分：81.6。通过后进入面试待安排')
  expect(confirmation.textContent).not.toContain('不会自动创建面试')
  expect(confirmation.textContent).not.toContain('填写线上会议链接')
})
