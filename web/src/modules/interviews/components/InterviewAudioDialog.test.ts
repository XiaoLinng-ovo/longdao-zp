// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import InterviewAudioDialog from './InterviewAudioDialog.vue'
import { getFullAudioTranscription, listInterviewRecordings, loadFullInterviewRecording, startFullAudioTranscription, type InterviewAudioRecording } from '../api/recordings'
import { WORKSPACE_CONTEXT_EVENT } from '../../../shared/api/workspace-context'
vi.mock('../api/recordings', () => ({ listInterviewRecordings: vi.fn(), loadFullInterviewRecording: vi.fn(), getFullAudioTranscription: vi.fn(), startFullAudioTranscription: vi.fn() }))
const list = vi.mocked(listInterviewRecordings), load = vi.mocked(loadFullInterviewRecording)
const getTranscript = vi.mocked(getFullAudioTranscription), startTranscript = vi.mocked(startFullAudioTranscription)
const rows: InterviewAudioRecording[] = ['a', 'b'].map((id, index) => ({ id, sessionId: 's', sessionStartedAt: '2026-10-20T00:00:00Z', offsetMs: index * 15000, endMs: (index + 1) * 15000, byteLength: 1024, contentType: 'audio/webm', createdAt: '2026-10-20T00:00:00Z' }))
let app: App | undefined, root: HTMLDivElement | undefined
async function flush() { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
async function mount(props: Record<string,unknown> = {}) {
  const open = ref(true); root = document.createElement('div'); document.body.append(root)
  app = createApp(defineComponent({ setup: () => () => open.value ? h(InterviewAudioDialog, { interviewId: 'i', candidate: '张三', job: '工程师', ...props, onClose: () => { open.value = false } }) : null }))
  app.mount(root); await flush(); return root
}
async function choose(el: HTMLElement, label: string, value: string) {
  const select = el.querySelector<HTMLSelectElement>('[aria-label="' + label + '"]')!; select.value = value; select.dispatchEvent(new Event('change')); await flush()
}
beforeEach(() => {
  list.mockResolvedValue(rows); load.mockResolvedValue(new Blob(['full'], { type: 'audio/mp4' }))
  getTranscript.mockResolvedValue(null); startTranscript.mockResolvedValue({ status:'completed',progress:100,text:'候选人介绍了项目经历。',updatedAt:'2026-10-21T00:00:00Z' })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  URL.createObjectURL = vi.fn().mockReturnValue('blob:audio'); URL.revokeObjectURL = vi.fn()
})
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.restoreAllMocks(); vi.resetAllMocks(); document.body.style.overflow = '' })

describe('InterviewAudioDialog whole-session playback', () => {
  it('transcribes the selected full recording and offers copy and text download', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText } })
    const el = await mount()
    expect(getTranscript).toHaveBeenCalledWith('i','s','all',expect.any(AbortSignal))
    const button = [...el.querySelectorAll<HTMLButtonElement>('.transcription button')].find(item => item.textContent?.includes('开始转写'))!
    button.click(); await flush()
    expect(startTranscript).toHaveBeenCalledWith('i','s','all',expect.any(AbortSignal))
    expect(el.querySelector<HTMLTextAreaElement>('[aria-label="整段转写结果"]')?.value).toBe('候选人介绍了项目经历。')
    el.querySelector<HTMLButtonElement>('.transcript-actions button')!.click(); await flush()
    expect(writeText).toHaveBeenCalledWith('候选人介绍了项目经历。')
    expect(el.textContent).toContain('已复制')
  })
  it('loads one full recording automatically, labels historical sources accurately, and cleans up on close', async () => {
    const el = await mount()
    expect(list).toHaveBeenCalledWith('i', expect.any(AbortSignal))
    expect(load).toHaveBeenCalledWith('i','s','all',expect.any(AbortSignal))
    expect(el.querySelectorAll('audio')).toHaveLength(1); expect(el.querySelectorAll('li')).toHaveLength(0)
    expect(el.textContent).toContain('来源未记录'); expect(el.textContent).toContain('下载整场音频')
    expect(el.textContent).not.toContain('67 段录音')
    el.querySelector<HTMLButtonElement>('[aria-label="关闭原音频"]')!.click(); await flush()
    expect(el.querySelector('[role="dialog"]')).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audio')
    expect(document.body.style.overflow).toBe('')
  })
  it('keeps online sources independent and preserves playback position and speed when switching', async () => {
    list.mockResolvedValue([{...rows[0]!,audioSource:'microphone'},{...rows[1]!,audioSource:'meeting'}])
    const el = await mount({ initialSessionId:'s',startMs:12000 })
    const audio = el.querySelector('audio')!; Object.defineProperty(audio,'duration',{value:30}); audio.dispatchEvent(new Event('loadedmetadata'))
    expect(audio.currentTime).toBe(12)
    await choose(el,'播放速度','1.5'); expect(audio.playbackRate).toBe(1.5)
    audio.currentTime = 18
    await choose(el,'回听音源','meeting')
    expect(load).toHaveBeenLastCalledWith('i','s','meeting',expect.any(AbortSignal))
    const remote = el.querySelector('audio')!; Object.defineProperty(remote,'duration',{value:30}); remote.dispatchEvent(new Event('loadedmetadata'))
    expect(remote.currentTime).toBe(18); expect(remote.playbackRate).toBe(1.5)
    expect(el.textContent).not.toContain('来源未记录')
  })
  it('keeps different sessions separate and resets seek on session changes', async () => {
    list.mockResolvedValue([...rows,{...rows[0]!,id:'new',sessionId:'new',sessionStartedAt:'2026-10-20T01:00:00Z'}])
    const el = await mount(); expect(load).toHaveBeenLastCalledWith('i','new','all',expect.any(AbortSignal))
    await choose(el,'采集场次','s'); expect(load).toHaveBeenLastCalledWith('i','s','all',expect.any(AbortSignal))
    const audio = el.querySelector('audio')!; audio.dispatchEvent(new Event('loadedmetadata')); expect(audio.currentTime).toBe(0)
  })
  it('shows missing originals and retries without starting recording', async () => {
    load.mockRejectedValueOnce(new Error('部分原音频文件不存在或已移除'))
    const el = await mount(); expect(el.querySelector('[role="alert"]')?.textContent).toContain('原音频文件不存在')
    el.querySelector<HTMLButtonElement>('.audio-error button')!.click(); await flush()
    expect(el.querySelector('audio')).not.toBeNull(); expect(el.querySelector('[role="alert"]')).toBeNull()
  })
  it('aborts stale source selections and releases private audio on workspace change', async () => {
    let resolve!: (blob: Blob) => void; load.mockReturnValueOnce(new Promise(r => { resolve = r }))
    const el = await mount(); const signal = load.mock.calls[0]![3]!
    await choose(el,'回听音源','legacy'); expect(signal.aborted).toBe(true)
    resolve(new Blob(['stale'])); await flush(); expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event(WORKSPACE_CONTEXT_EVENT)); await flush(); expect(el.querySelector('[role="dialog"]')).toBeNull()
  })
  it('aborts pending download on unmount and never creates an audio URL from its late response', async () => {
    let resolve!: (blob: Blob) => void; load.mockReturnValueOnce(new Promise(r => { resolve = r }))
    await mount(); const signal = load.mock.calls[0]![3]!; app?.unmount(); app = undefined
    expect(signal.aborted).toBe(true); resolve(new Blob(['late'])); await flush(); expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
  it('retries list failure and shows an empty state, plus accurate in-progress notices', async () => {
    list.mockRejectedValueOnce(new Error('网络暂时不可用')).mockResolvedValueOnce([])
    const el = await mount({pendingCount:2,recording:true}); expect(el.textContent).toContain('网络暂时不可用')
    expect(el.textContent).toContain('已保存部分'); expect(el.textContent).toContain('还有 2 份录音')
    el.querySelector<HTMLButtonElement>('.audio-toolbar button')!.click(); await flush()
    expect(el.textContent).toContain('暂无已保存的原音频'); expect(load).not.toHaveBeenCalled()
  })
})
