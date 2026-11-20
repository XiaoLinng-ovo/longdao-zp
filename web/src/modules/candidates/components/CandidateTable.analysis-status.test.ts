// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import CandidateTable from './CandidateTable.vue'
import type { Candidate } from '../../../shared/types/recruiting'

let app: App | undefined
let root: HTMLDivElement | undefined

const base: Candidate = {
  id: 'CAN-1',
  entityId: 'candidate-1',
  name: '王强',
  job: '人事',
  score: 0,
  aiStatus: 'pending',
  applicationStatus: 'pending',
  rawApplicationStatus: 'pending_analysis',
  updatedAt: '2026-11-05',
  applicationId: 'application-1',
}

async function mount(row: Candidate) {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(CandidateTable, { rows: [row] })
  app.mount(root)
  await nextTick()
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = undefined
  root = undefined
})

describe('candidate analysis status presentation', () => {
  it.each([
    ['queued', '排队等待 AI 分析', '排队中'],
    ['processing', 'AI 正在分析，完成后生成评分', '分析中'],
    ['failed', 'AI 分析失败，可重试', '失败'],
    ['completed', '分析完成，未生成有效评分', '待处理'],
  ] as const)('renders %s as its own stage without contradiction', async (analysisStatus, advice, applicationStatus) => {
    await mount({ ...base, analysisStatus })

    expect(root!.querySelector('.advice-cell')!.textContent).toContain(advice)
    expect(root!.querySelector('.analysis-progress')!.textContent).toContain(
      { queued: '排队中', processing: '分析中', failed: '失败', completed: '已完成' }[analysisStatus],
    )
    expect(root!.querySelector('.status-tag:last-of-type')!.textContent).toContain(applicationStatus)
  })

  it('does not show pending analysis while an AI task is queued', async () => {
    await mount({ ...base, analysisStatus: 'queued' })

    const applicationCell = root!.querySelector('tbody tr td:nth-child(8)')!
    expect(applicationCell.textContent).toContain('排队中')
    expect(applicationCell.textContent).not.toContain('待分析')
  })
})
