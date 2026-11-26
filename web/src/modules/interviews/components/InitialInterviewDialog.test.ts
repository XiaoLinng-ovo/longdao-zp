// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import InitialInterviewDialog from './InitialInterviewDialog.vue'
import { loadInterviewScheduleData } from '../api'

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  loadInterviewScheduleData: vi.fn(),
  createInterview: vi.fn(),
}))

let app: App | undefined
let root: HTMLDivElement | undefined

async function flush() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mountDialog(onClose: () => void) {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(InitialInterviewDialog, { applicationId: 'application-1', onClose })
  app.mount(root)
  await flush()
}

function fillForm() {
  const time = root!.querySelector<HTMLInputElement>('#initial-time')!
  time.value = '2026-11-08T10:00'
  time.dispatchEvent(new Event('input', { bubbles: true }))

  const meeting = root!.querySelector<HTMLInputElement>('#initial-meeting')!
  meeting.value = 'https://meeting.example.com/initial'
  meeting.dispatchEvent(new Event('input', { bubbles: true }))

  const interviewer = root!.querySelector<HTMLSelectElement>('#initial-interviewer')!
  interviewer.value = 'user-1'
  interviewer.dispatchEvent(new Event('change', { bubbles: true }))

  return { time, meeting, interviewer }
}

beforeEach(() => {
  vi.mocked(loadInterviewScheduleData).mockResolvedValue({
    candidates: [{ id: 'candidate-1', code: 'CAN-1', fullName: '测试候选人' }],
    jobs: [{ id: 'job-1', code: 'JOB-1', title: '测试岗位' }],
    applications: [{ id: 'application-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'interviewing' }],
    interviewers: [{ id: 'user-1', displayName: '面试官甲' }],
  })
})

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  root = undefined
  vi.resetAllMocks()
})

describe('初试邀约弹窗关闭', () => {
  it('日期控件产生的无按下来源点击不会关闭弹窗或清空已填内容', async () => {
    const onClose = vi.fn()
    await mountDialog(onClose)
    const { meeting, interviewer } = fillForm()
    await flush()

    const overlay = root!.querySelector('.overlay')!
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flush()

    expect(onClose).not.toHaveBeenCalled()
    expect(root!.querySelector('.initial-interview-dialog')).not.toBeNull()
    expect(meeting.value).toBe('https://meeting.example.com/initial')
    expect(interviewer.value).toBe('user-1')
  })

  it('从日期输入框按 Esc 只退出日期控件，不关闭整个邀约', async () => {
    const onClose = vi.fn()
    await mountDialog(onClose)
    const { time } = fillForm()
    await flush()

    time.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
    await flush()

    expect(onClose).not.toHaveBeenCalled()
    expect(root!.querySelector('.initial-interview-dialog')).not.toBeNull()
  })

  it('真实点击遮罩空白处仍会关闭弹窗', async () => {
    const onClose = vi.fn()
    await mountDialog(onClose)
    const overlay = root!.querySelector('.overlay')!

    overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flush()

    expect(onClose).toHaveBeenCalledOnce()
  })
})
