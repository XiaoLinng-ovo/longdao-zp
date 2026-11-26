// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TranscriptRoleCorrection from './TranscriptRoleCorrection.vue'
import { loadLiveInterviewSession, correctTranscriptRoles, type LiveInterviewView } from '../api'
vi.mock('../api', () => ({ loadLiveInterviewSession: vi.fn(), correctTranscriptRoles: vi.fn() }))
let app: App | undefined, root: HTMLDivElement
const view = (): LiveInterviewView => ({ session: { id: 's', interviewId: 'i', status: 'completed', endedAt: '2026-11-26', startedAt: '', createdBy: '', currentQuestion: '', externalStatus: '' }, completionReview: { phase: 'completed', versionId: 'v1', unresolvedCount: 1, unresolvedIds: ['a'], limit: 30 }, segments: [{ id: 'a', sessionId: 's', speakerId: 'voice1', role: 'unknown', confidence: .35, text: '候选人项目经历', startMs: 0, endMs: 1000, status: 'transcribed' }, { id: 'b', sessionId: 's', speakerId: 'voice2', role: 'interviewer', confidence: .9, text: '复述后进一步追问', startMs: 1200, endMs: 2000, status: 'transcribed' }] })
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
async function click(text: string) { [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === text)!.click(); await flush() }
async function mount() { root = document.createElement('div'); document.body.appendChild(root); app = createApp(TranscriptRoleCorrection, { sessionId: 's' }); app.mount(root); await flush() }
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks() })
describe('post-interview role correction', () => {
  it('loads only on demand, filters uncertainty and saves selected turns against the transcript version', async () => {
    vi.mocked(loadLiveInterviewSession).mockResolvedValue(view()); vi.mocked(correctTranscriptRoles).mockResolvedValue(view())
    await mount(); expect(loadLiveInterviewSession).not.toHaveBeenCalled(); await click('说话人校正')
    const uncertain = [...root.querySelectorAll('label')].find(label => label.textContent?.includes('仅看不确定片段'))!.querySelector('input')!
    uncertain.click(); await flush()
    expect(root.querySelectorAll('.role-turn')).toHaveLength(1)
    await click('选择当前片段'); await click('设为候选人')
    expect(correctTranscriptRoles).toHaveBeenCalledWith('s', 'v1', ['a'], 'candidate')
    expect(root.textContent).toContain('请点击重新评分')
  })
  it('retains selected evidence and exposes errors after a version conflict', async () => {
    vi.mocked(loadLiveInterviewSession).mockResolvedValue(view()); vi.mocked(correctTranscriptRoles).mockRejectedValue(new Error('转写版本已更新'))
    await mount(); await click('说话人校正'); root.querySelector<HTMLInputElement>('.role-turn input')!.click(); await flush(); await click('设为面试官')
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('转写版本已更新')
    expect(root.querySelector<HTMLInputElement>('.role-turn input')!.checked).toBe(true)
  })
})
