// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import CandidateTable from './CandidateTable.vue'
import type { Candidate } from '../../../shared/types/recruiting'

let app: App | undefined
let root: HTMLDivElement
const onDelete = vi.fn(), onAnalyze = vi.fn()
const base: Candidate = { id: 'CAN-1', entityId: 'candidate-1', name: '王强', job: '人事', score: 0, aiStatus: 'pending', applicationStatus: 'pending', rawApplicationStatus: 'pending_analysis', updatedAt: '2026-10-08', applicationId: 'application-1' }
function rows(count = 2): Candidate[] {
  const applications = Array.from({ length: count }, (_, i) => ({ ...base, applicationId: `application-${i + 1}`, job: i ? `算法工程师${i}` : '人事' }))
  return [{ ...applications[0], applicationRows: applications }]
}
async function mount(count = 2) {
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(CandidateTable, { rows: rows(count), canDelete: true, canApply: true, onDelete, onAnalyze })
  app.mount(root); await nextTick()
}
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks() })
describe('candidate grouped application table', () => {
  it.each([2, 3])('merges the centered candidate cell across %s applications and restores it on collapse', async (count) => {
    await mount(count)
    const toggle = root.querySelector<HTMLButtonElement>('.applications-toggle')!
    expect(toggle.textContent).toBe(`展开 ${count} 个岗位申请`)
    expect(root.querySelectorAll('tbody tr')).toHaveLength(1)
    toggle.click(); await nextTick()
    expect(root.querySelectorAll('tbody tr')).toHaveLength(count)
    expect(root.querySelectorAll('.candidate-cell')).toHaveLength(1)
    expect(root.querySelector<HTMLTableCellElement>('.candidate-cell')!.rowSpan).toBe(count)
    expect(root.querySelectorAll('.name-link')).toHaveLength(1)
    expect(root.querySelector('.name-link')!.textContent).toBe('王强')
    expect(root.textContent).not.toContain('↳ 岗位申请')
    expect(toggle.textContent).toBe(`收起 ${count} 个岗位申请`)
    toggle.click(); await nextTick()
    expect(root.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(root.querySelector<HTMLTableCellElement>('.candidate-cell')!.rowSpan).toBe(1)
  })
  it('exposes delete on every application and emits the chosen application rather than the whole candidate', async () => {
    await mount()
    root.querySelector<HTMLButtonElement>('.applications-toggle')!.click(); await nextTick()
    const buttons = root.querySelectorAll<HTMLButtonElement>('.delete-button')
    expect(buttons).toHaveLength(2)
    expect(buttons[1].getAttribute('aria-label')).toContain('算法工程师1')
    buttons[1].click()
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ applicationId: 'application-2', entityId: 'candidate-1' }))
  })
  it('provides analysis for an application with no analysis task yet', async () => {
    await mount()
    const button = [...root.querySelectorAll('button')].find((item) => item.textContent === '解析简历')!
    expect(button.disabled).toBe(false); button.click()
    expect(onAnalyze).toHaveBeenCalledWith(expect.objectContaining({ applicationId: 'application-1' }))
  })
})
