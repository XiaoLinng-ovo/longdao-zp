// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import ResumeImportDetailPage from './ResumeImportDetailPage.vue'
import { detachResumeImportJob, getResumeImportBatch, type ApiResumeImportBatch } from '../api'
import { authSession } from '../../auth/session'

vi.mock('../api', () => ({ getResumeImportBatch: vi.fn(), detachResumeImportJob: vi.fn(), cancelResumeImportBatch: vi.fn() }))
vi.mock('../../auth/session', () => ({ authSession: { user: { role: 'recruiter' } } }))
const batch: ApiResumeImportBatch = {
  id: 'batch-1', jobId: 'job-1', status: 'completed', createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T00:00:00Z',
  counts: { total: 2, pendingUpload: 0, uploading: 0, uploaded: 2, analyzing: 0, completed: 1, failed: 1, cancelled: 0 },
  items: [
    { id: 'file-1', batchId: 'batch-1', ordinal: 1, clientFileId: '1', originalFilename: '张三.pdf', mimeType: 'application/pdf', sizeBytes: 100, status: 'queued', analysisStatus: 'completed', candidateId: 'candidate-1', applicationId: 'app-1', attempts: 1, createdAt: '', updatedAt: '' },
    { id: 'file-2', batchId: 'batch-1', ordinal: 2, clientFileId: '2', originalFilename: '错误.pdf', mimeType: 'application/pdf', sizeBytes: 100, status: 'failed', error: '文件无法解析', attempts: 1, createdAt: '', updatedAt: '' },
  ],
}
let app: App | undefined
let root: HTMLDivElement
async function flush() { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
async function mount() {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/resume-import-batches/:id', name: 'resume-import-detail', component: { template: '<div />' } },
    { path: '/jobs', name: 'jobs', component: { template: '<div />' } },
    { path: '/candidates/:id', name: 'candidate-detail', component: { template: '<div />' } },
  ] })
  await router.push('/resume-import-batches/batch-1')
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(ResumeImportDetailPage); app.use(router); app.mount(root); await flush()
  return router
}
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks() })
describe('简历导入批次详情', () => {
  it('按批次展示处理结果并提供精确的应聘记录入口，不修改历史数据', async () => {
    vi.mocked(getResumeImportBatch).mockResolvedValue(batch)
    const router = await mount()
    expect(getResumeImportBatch).toHaveBeenCalledWith('batch-1')
    expect(root.textContent).toContain('已结束（有异常）')
    expect(root.textContent).toContain('张三.pdf')
    expect(root.textContent).toContain('文件无法解析')
    const link = root.querySelector<HTMLAnchorElement>('tbody a')!
    expect(link.getAttribute('href')).toBe('/candidates/candidate-1?applicationId=app-1')
    link.click()
    await vi.waitFor(() => expect(router.currentRoute.value.query.applicationId).toBe('app-1'))
    expect([...root.querySelectorAll('button')].map(button => button.textContent?.trim())).toEqual(['解除岗位关联', '刷新'])
  })
  it('读取失败时显示具体错误并可刷新重试', async () => {
    vi.mocked(getResumeImportBatch).mockRejectedValueOnce(new Error('导入批次不存在')).mockResolvedValueOnce(batch)
    await mount()
    expect(root.querySelector('[role=alert]')?.textContent).toContain('导入批次不存在')
    ;[...root.querySelectorAll('button')].find(button => button.textContent?.trim() === '刷新')!.click(); await flush()
    expect(root.querySelector('[role=alert]')).toBeNull()
    expect(root.textContent).toContain('张三.pdf')
  })
  it('解除关联需要确认，保留批次和文件并返回对应岗位的关联列表', async () => {
    vi.mocked(getResumeImportBatch).mockResolvedValue(batch)
    vi.mocked(detachResumeImportJob).mockResolvedValue({ ...batch, jobId: '', detachedJobId: 'job-1', detachedJobTitle: '测试岗位', detachedAt: '2026-11-12T01:00:00Z' })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await mount()
    const detach = [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === '解除岗位关联')!
    detach.click(); await flush()
    expect(detachResumeImportJob).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    detach.click(); await flush()
    expect(detachResumeImportJob).toHaveBeenCalledWith('batch-1')
    expect(root.textContent).toContain('已解除岗位关联')
    expect(root.textContent).toContain('张三.pdf')
    expect(root.textContent).toContain('测试岗位')
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/jobs?relatedJobId=job-1')
    expect(root.textContent).not.toContain('解除岗位关联失败')
    confirm.mockRestore()
  })
  it('正在分析的批次不能解除关联', async () => {
    vi.mocked(getResumeImportBatch).mockResolvedValue({ ...batch, status: 'cancelled', items: [{ ...batch.items[0]!, analysisStatus: 'processing' }] })
    await mount()
    const detach = [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === '解除岗位关联')!
    expect(detach.disabled).toBe(true)
  })
  it('无岗位写权限不展示解除关联操作', async () => {
    authSession.user!.role = 'interviewer'
    vi.mocked(getResumeImportBatch).mockResolvedValue(batch)
    await mount()
    expect([...root.querySelectorAll('button')].some(button => button.textContent?.trim() === '解除岗位关联')).toBe(false)
    authSession.user!.role = 'recruiter'
  })
})
