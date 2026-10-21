// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import ResumeDocumentDialog from './ResumeDocumentDialog.vue'
import { getResumeDocument, type ApiResumeDocument } from '../api'

vi.mock('../api', () => ({ getResumeDocument: vi.fn() }))
let app: App | undefined
let root: HTMLDivElement | undefined
const close = vi.fn()
const createUrl = vi.fn(() => 'blob:resume-original')
const revokeUrl = vi.fn()
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() {} })
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() {} })
async function flush() { for (let i = 0; i < 15; i++) { await Promise.resolve(); await nextTick() } }
async function mount(result: ApiResumeDocument) {
  vi.mocked(getResumeDocument).mockResolvedValue(result)
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.setAttribute('open', '') })
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.removeAttribute('open') })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }))
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(ResumeDocumentDialog, { candidateId: 'candidate-1', resumeId: 'resume-1', filename: result.originalFilename, onClose: close })
  app.mount(root); await flush()
}
afterEach(() => { app?.unmount(); root?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })
const textDocument = { originalFilename: 'resume.txt', mimeType: 'text/plain', content: btoa('Original resume\nFull contents') }

describe('original resume preview', () => {
  it('loads the selected original and displays all text with a download link', async () => {
    await mount(textDocument)
    expect(getResumeDocument).toHaveBeenCalledWith('candidate-1', 'resume-1')
    expect(root!.querySelector('pre')?.textContent).toBe('Original resume\nFull contents')
    expect(root!.querySelector('a')?.getAttribute('download')).toBe('resume.txt')
    expect(root!.querySelector('a')?.getAttribute('href')).toBe('blob:resume-original')
  })
  it('previews PDFs without interpreting their bytes as text', async () => {
    await mount({ originalFilename: 'resume.pdf', mimeType: 'application/pdf', content: btoa('%PDF-1.4') })
    expect(root!.querySelector('iframe')?.getAttribute('src')).toBe('blob:resume-original')
    expect(root!.querySelector('pre')).toBeNull()
  })
  it('sandboxes Word content and removes scripts, external links and images', async () => {
    await mount({ originalFilename: 'resume.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: btoa('PK'), previewHtml: '<h1>Original Word content</h1><script>alert(1)</script><a href="https://example.com">link</a><img src="https://example.com/tracker" onerror="alert(1)">' })
    const frame = root!.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toContain('Original Word content')
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy')
    expect(frame.getAttribute('srcdoc')).not.toMatch(/alert|https:\/\/example.com|onerror/)
    expect(root!.querySelector('a')?.getAttribute('download')).toBe('resume.docx')
  })
  it('retains original download when legacy Word preview is unavailable', async () => {
    await mount({ originalFilename: 'resume.doc', mimeType: 'application/msword', content: btoa('binary word') })
    expect(root!.textContent).toContain('暂不支持在线预览')
    expect(root!.querySelector('a')?.getAttribute('download')).toBe('resume.doc')
  })
  it('shows actionable errors and supports retry', async () => {
    await mount(textDocument)
    vi.mocked(getResumeDocument).mockRejectedValueOnce(new Error('文件不可用'))
    // Remount to exercise an initial request failure.
    app!.unmount(); app = createApp(ResumeDocumentDialog, { candidateId: 'candidate-1', resumeId: 'resume-1', filename: 'resume.txt', onClose: close }); app.mount(root!); await flush()
    expect(root!.querySelector('[role="alert"]')).not.toBeNull()
    const retry = [...root!.querySelectorAll('button')].find(button => button.textContent === '重试')!
    retry.click(); await flush()
    expect(root!.querySelector('pre')?.textContent).toContain('Original resume')
  })
  it('closes with Escape and releases the document URL on unmount', async () => {
    await mount(textDocument)
    root!.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(close).toHaveBeenCalledOnce()
    app!.unmount(); app = undefined
    expect(revokeUrl).toHaveBeenCalledWith('blob:resume-original')
  })
  it('ignores a response arriving after the preview is closed', async () => {
    await mount(textDocument)
    app!.unmount(); createUrl.mockClear()
    let resolve!: (value: ApiResumeDocument) => void
    vi.mocked(getResumeDocument).mockReturnValueOnce(new Promise(done => { resolve = done }))
    app = createApp(ResumeDocumentDialog, { candidateId: 'candidate-1', resumeId: 'resume-1', filename: 'resume.txt', onClose: close }); app.mount(root!)
    app.unmount(); app = undefined
    resolve(textDocument); await flush()
    expect(createUrl).not.toHaveBeenCalled()
  })
})

