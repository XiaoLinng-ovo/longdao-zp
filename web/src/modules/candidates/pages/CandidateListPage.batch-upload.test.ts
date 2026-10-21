// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import CandidateListPage from './CandidateListPage.vue'
import { createApplication, createCandidate, loadCandidates, uploadResume } from '../api'

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  createApplication: vi.fn(), createCandidate: vi.fn(), uploadResume: vi.fn(),
  loadCandidates: vi.fn(), loadCandidateTags: vi.fn(async () => []),
  loadJobs: vi.fn(async () => [{ id: 'JOB-1', entityId: 'job-1', title: '人事专员' }]),
}))
const create = vi.mocked(createCandidate)
const apply = vi.mocked(createApplication)
const upload = vi.mocked(uploadResume)
let app: App | undefined
let root: HTMLDivElement
let candidateIndex = 0
async function flush() { for (let i = 0; i < 16; i++) { await Promise.resolve(); await nextTick() } }
async function waitFor(check: () => void) {
  let last: unknown
  for (let i = 0; i < 100; i++) { try { check(); return } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 0)); await flush() } }
  throw last
}
async function mount() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  await router.push('/')
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(CandidateListPage); app.use(router); app.mount(root); await flush()
  button('上传简历并建档').click(); await flush()
}
function button(label: string) { return [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)! }
function submit() { return root.querySelector<HTMLButtonElement>('.resume-submit')! }
function files(...values: File[]) {
  const input = root.querySelector<HTMLInputElement>('#candidate-resume-file')!
  Object.defineProperty(input, 'files', { configurable: true, value: values })
  input.dispatchEvent(new Event('change'))
}
function job() {
  const select = root.querySelector<HTMLSelectElement>('#candidate-resume-job')!
  select.value = 'job-1'; select.dispatchEvent(new Event('change'))
}
function file(name: string) { return new File(['resume'], name, { type: 'text/plain', lastModified: 1 }) }
function completedUpload(input: Parameters<typeof uploadResume>[0]) {
  return { resume: { id: 'resume-' + input.candidateId }, task: { id: 'task-' + input.candidateId, status: 'queued' } } as Awaited<ReturnType<typeof uploadResume>>
}
beforeEach(() => {
  candidateIndex = 0
  vi.mocked(loadCandidates).mockResolvedValue([])
  create.mockImplementation(async () => ({ id: 'candidate-' + ++candidateIndex }) as Awaited<ReturnType<typeof createCandidate>>)
  apply.mockImplementation(async input => ({ id: 'app-' + input.candidateId, ...input }) as Awaited<ReturnType<typeof createApplication>>)
  upload.mockImplementation(async input => completedUpload(input))
})
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.restoreAllMocks(); vi.clearAllMocks() })

describe('single and batch resume upload', () => {
  it('supports multiple selection, append, duplicate suppression, remove and reselection', async () => {
    await mount()
    expect(root.querySelector<HTMLInputElement>('#candidate-resume-file')!.multiple).toBe(true)
    const a = file('张三.txt'), b = file('李四.txt')
    files(a, b); await flush()
    expect(root.querySelectorAll('.resume-file-row')).toHaveLength(2)
    files(a, file('王五.txt')); await flush()
    expect(root.querySelectorAll('.resume-file-row')).toHaveLength(3)
    root.querySelector<HTMLButtonElement>('[aria-label="移除 张三.txt"]')!.click(); await flush()
    expect(root.querySelectorAll('.resume-file-row')).toHaveLength(2)
    files(a); await flush()
    expect(root.querySelectorAll('.resume-file-row')).toHaveLength(3)
    expect(submit().textContent).toContain('3份')
  })
  it('validates files and job before creating any database records', async () => {
    await mount(); submit().click(); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('请选择简历文件')
    files(file('bad.exe'), new File([], 'empty.txt'), new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.pdf'), file('valid.txt')); await flush()
    expect(root.querySelectorAll('.resume-file-row')).toHaveLength(1)
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('不支持此文件格式')
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('文件为空')
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('不能超过 10 MB')
    submit().click(); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('请选择简历对应岗位')
    expect(create).not.toHaveBeenCalled()
  })
  it('keeps single-file behavior and resets the completed queue when reopened', async () => {
    await mount(); files(file('张三.txt')); job(); await flush(); submit().click()
    await waitFor(() => expect(root.querySelector('.resume-dialog')).toBeNull())
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ originalFilename: '张三.txt', candidateId: 'candidate-1', applicationId: 'app-candidate-1', encoding: 'base64' }))
    button('上传简历并建档').click(); await flush()
    expect(root.querySelectorAll('.resume-file-row')).toHaveLength(0)
    expect(root.querySelector<HTMLSelectElement>('#candidate-resume-job')!.value).toBe('')
  })
  it('uploads all files independently to the same job and reports all submitted results', async () => {
    await mount(); files(file('张三.txt'), file('李四.txt'), file('王五.txt')); job(); await flush(); submit().click(); submit().click()
    await waitFor(() => expect(root.querySelectorAll('[data-status="queued"]')).toHaveLength(3))
    await waitFor(() => expect(submit().textContent).not.toContain('上传中'))
    expect(create).toHaveBeenCalledTimes(3)
    expect(apply.mock.calls.map(call => call[0].jobId)).toEqual(['job-1', 'job-1', 'job-1'])
    expect(upload.mock.calls.map(call => [call[0].originalFilename, call[0].candidateId, call[0].applicationId])).toEqual([
      ['张三.txt', 'candidate-1', 'app-candidate-1'], ['李四.txt', 'candidate-2', 'app-candidate-2'], ['王五.txt', 'candidate-3', 'app-candidate-3'],
    ])
    expect(submit().disabled).toBe(true)
    expect(root.textContent).toContain('已提交 3 份简历')
    button('完成').click(); await flush()
    expect(root.querySelector('.resume-dialog')).toBeNull()
  })
  it('continues after upload failure and retries only the failed file using existing records', async () => {
    upload.mockImplementation(async input => { if (input.originalFilename === '李四.txt') throw Error('网络连接中断'); return completedUpload(input) })
    await mount(); files(file('张三.txt'), file('李四.txt'), file('王五.txt')); job(); await flush(); submit().click()
    await waitFor(() => expect(submit().textContent).toContain('重试失败文件'))
    expect(root.querySelectorAll('[data-status="queued"]')).toHaveLength(2)
    expect(root.querySelectorAll('[data-status="failed"]')).toHaveLength(1)
    expect(root.textContent).toContain('网络连接中断')
    expect(root.textContent).toContain('重试将复用')
    expect(root.querySelector<HTMLSelectElement>('#candidate-resume-job')!.disabled).toBe(true)
    upload.mockImplementation(async input => completedUpload(input))
    submit().click()
    await waitFor(() => expect(root.querySelectorAll('[data-status="queued"]')).toHaveLength(3))
    expect(create).toHaveBeenCalledTimes(3)
    expect(apply).toHaveBeenCalledTimes(3)
    expect(upload).toHaveBeenCalledTimes(4)
    expect(upload.mock.calls[3]![0]).toMatchObject({ originalFilename: '李四.txt', candidateId: 'candidate-2', applicationId: 'app-candidate-2' })
  })
  it('retries a failed application creation without creating the candidate twice', async () => {
    apply.mockRejectedValueOnce(Error('岗位申请创建失败'))
    await mount(); files(file('张三.txt'), file('李四.txt')); job(); await flush(); submit().click()
    await waitFor(() => expect(submit().textContent).toContain('重试失败文件'))
    expect(upload).toHaveBeenCalledTimes(1)
    submit().click()
    await waitFor(() => expect(root.querySelectorAll('[data-status="queued"]')).toHaveLength(2))
    expect(create).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(3)
    expect(upload).toHaveBeenCalledTimes(2)
  })
  it('locks file selection, job, close and submit during an active upload', async () => {
    let release!: (value: Awaited<ReturnType<typeof uploadResume>>) => void
    upload.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await mount(); files(file('张三.txt'), file('李四.txt')); job(); await flush(); submit().click()
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    expect(root.querySelector<HTMLInputElement>('#candidate-resume-file')!.disabled).toBe(true)
    expect(root.querySelector<HTMLSelectElement>('#candidate-resume-job')!.disabled).toBe(true)
    expect(root.querySelector<HTMLButtonElement>('.resume-close')!.disabled).toBe(true)
    expect(submit().disabled).toBe(true)
    root.querySelector('.resume-overlay')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush()
    expect(root.querySelector('.resume-dialog')).not.toBeNull()
    release(completedUpload(upload.mock.calls[0]![0]))
    await waitFor(() => expect(root.querySelectorAll('[data-status="queued"]')).toHaveLength(2))
  })
})
