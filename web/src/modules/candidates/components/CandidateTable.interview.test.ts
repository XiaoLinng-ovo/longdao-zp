// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import CandidateTable from './CandidateTable.vue'
import type { Candidate, CandidateInterviewProgress } from '../../../shared/types/recruiting'

let app: App | undefined
let root: HTMLDivElement | undefined
const base: Candidate = { id: 'CAN-1', name: '测试候选人', job: 'AI应用工程师', applicationId: 'app-1', score: 82, aiStatus: 'completed', rawApplicationStatus: 'interviewing', applicationStatus: 'scheduled', updatedAt: '2026-10-16', resumeReview: { resultId: 'result-1', aiScore: 82, decision: 'passed', talentPool: false, history: [], evidence: [], strengths: [], risks: [] } }
async function mount(row: Candidate) {
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(CandidateTable, { rows: [row], canArrange: true, canReview: true })
  app.mount(root); await nextTick()
}
const schedulingButtons = () => [...root!.querySelectorAll('button')].filter((button) => ['安排面试', '初试邀约'].includes(button.textContent!.trim()))
afterEach(() => { app?.unmount(); root?.remove() })

describe('candidate interview status', () => {
  it.each([
    ['initial', 'scheduled', '初试已安排'], ['initial', 'completed', '初试已完成'],
    ['final', 'scheduled', '复试已安排'], ['final', 'completed', '复试已完成'],
  ] as const)('shows %s %s below the name and hides duplicate scheduling', async (stage, status, label) => {
    await mount({ ...base, interviewProgress: { id: 'interview-1', round: stage === 'initial' ? 1 : 2, stage, status } })
    expect(root!.querySelector('.candidate-cell .interview-hint')?.textContent).toBe(label)
    expect(root!.querySelector('.name-link')!.nextElementSibling?.textContent).toBe(label)
    expect(schedulingButtons()).toHaveLength(0)
    expect(root!.textContent).not.toContain('待安排初试')
  })
  it('keeps scheduling available for a passed application with no active interview', async () => {
    await mount(base)
    expect(root!.querySelector('.interview-hint')?.textContent).toBe('已通过 · 待安排初试')
    expect(schedulingButtons()).toHaveLength(1)
    expect(root!.querySelector('.advice-cell')!.textContent).not.toContain('待安排初试')
  })
  it('keeps progress and scheduling separate across grouped applications', async () => {
    const progress: CandidateInterviewProgress = { id: 'interview-1', round: 1, stage: 'initial', status: 'scheduled' }
    const arranged = { ...base, interviewProgress: progress }
    const pending = { ...base, applicationId: 'app-2', job: '人事' }
    await mount({ ...arranged, applicationRows: [arranged, pending] })
    expect([...root!.querySelectorAll('.interview-hint')].map((item) => item.textContent)).toEqual(['AI应用工程师 · 初试已安排', '人事 · 已通过 · 待安排初试'])
    expect(schedulingButtons()).toHaveLength(0)
    root!.querySelector<HTMLButtonElement>('.applications-toggle')!.click(); await nextTick()
    expect(schedulingButtons()).toHaveLength(1)
    expect(schedulingButtons()[0].closest('tr')!.querySelector('.job-cell')!.textContent).toBe('人事')
  })
})
