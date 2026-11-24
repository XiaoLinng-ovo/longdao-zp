import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { RESUME_OCR_TIMEOUT_MS, mergeResumeOcrPages, orderResumePdfPage, resumeBodyCharacterCount, resumePdfImageRegions, resumePdfPageNeedsOcr, resumeTextHasEncodingDamage } from '@smartrecruit-pro/resume-intelligence'
import mammoth from 'mammoth'
import { WorkerFailure } from './errors.js'
import { EnterpriseAiError, meterOcrOperation } from '@smartrecruit-pro/enterprise-ai'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PDFJS_ROOT = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')).replaceAll('\\', '/')

async function recognizeWithOcr(content: Buffer, filename: string, mimeType?: string, originalPages?: string[], requiredPages?: number[], resolveBillingEnv?: () => Promise<NodeJS.ProcessEnv>): Promise<string> {
  const baseUrl = process.env.OCR_SERVICE_URL?.trim()
  if (!baseUrl) throw new WorkerFailure('简历包含图片正文，需要 OCR 识别，但 OCR_SERVICE_URL 未配置。', { category: 'dependency_unavailable', code: 'OCR_NOT_CONFIGURED', retryable: false })
  const form = new FormData()
  form.append('file', new Blob([Uint8Array.from(content)], { type: mimeType ?? 'application/octet-stream' }), filename)
  if (requiredPages?.length) form.append('pages', JSON.stringify(requiredPages))
  try {
    const dispatch = async () => {
    const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/ocr`, { method: 'POST', body: form, signal: AbortSignal.timeout(RESUME_OCR_TIMEOUT_MS) })
    if (!response.ok) {
      await response.body?.cancel()
      throw new WorkerFailure(`OCR 识别服务返回 HTTP ${response.status}，尚未生成评分。`, { category: 'dependency_unavailable', code: 'OCR_HTTP_ERROR', retryable: response.status === 429 || response.status >= 500 })
    }
    const payload = await response.json() as { text?: unknown; engine?: unknown; pages?: unknown }
    if (typeof payload?.text !== 'string' || resumeBodyCharacterCount(payload.text) < 5) throw new WorkerFailure('OCR 未识别到有效简历正文，尚未生成评分；请检查原文件清晰度。', { category: 'validation', code: 'OCR_TEXT_EMPTY', retryable: false })
    if (resumeTextHasEncodingDamage(payload.text)) throw new WorkerFailure('OCR 结果仍存在明显乱码，尚未生成评分；请检查原文件清晰度或重新导出 PDF。', { category: 'validation', code: 'OCR_TEXT_GARBLED', retryable: false })
    return {text:payload.text, engine:typeof payload.engine==='string' ? payload.engine : 'PP-StructureV3', ...(Array.isArray(payload.pages) ? {pages:payload.pages} : {})}
    }
    const payload = resolveBillingEnv ? await meterOcrOperation(await resolveBillingEnv(), content, requiredPages, dispatch) : await dispatch()
    return originalPages && requiredPages?.length ? mergeResumeOcrPages(payload, originalPages, requiredPages) : payload.text
  } catch (error) {
    if (error instanceof EnterpriseAiError) throw new WorkerFailure(error.message, { category:'dependency_unavailable', code:error.code, retryable:false })
    if (error instanceof WorkerFailure) throw error
    throw new WorkerFailure('OCR 识别服务未启动、连接失败或响应超时；图片简历尚未识别，未生成评分。', { category: 'dependency_unavailable', code: 'OCR_UNAVAILABLE', retryable: false, cause: error })
  }
}

export async function extractResumeText(content: Buffer, filename: string, mimeType?: string, resolveBillingEnv?: () => Promise<NodeJS.ProcessEnv>): Promise<string> {
  const extension = filename.toLowerCase().split('.').pop() ?? ''
  if (extension === 'txt' || extension === 'md') {
    if (mimeType && !mimeType.startsWith('text/')) throw new Error(`Resume MIME/extension mismatch: ${mimeType}`)
    return content.toString('utf8')
  }
  if (extension === 'docx' || mimeType === DOCX_MIME) {
    if (extension !== 'docx') throw new Error('DOCX filename extension is required')
    return (await mammoth.extractRawText({ buffer: content })).value
  }
  if (extension === 'pdf' || mimeType === 'application/pdf') {
    if (extension !== 'pdf') throw new Error('PDF filename extension is required')
    // CJK CID fonts can silently disappear without PDF.js's bundled CMaps.
    const task = getDocument({
      data: Uint8Array.from(content), verbosity: 0, isEvalSupported: false, stopAtErrors: true,
      cMapUrl: `${PDFJS_ROOT}/cmaps/`, cMapPacked: true,
      standardFontDataUrl: `${PDFJS_ROOT}/standard_fonts/`,
    })
    try {
      const document = await task.promise
      const pages: string[] = []
      const requiredPages: number[] = []
      for (let index = 1; index <= document.numPages; index++) {
        const page = await document.getPage(index)
        const viewport = page.getViewport({ scale: 1 })
        const { items } = await page.getTextContent()
        const positioned = items.flatMap((item) => {
          if (!('str' in item)) return []
          const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
          return [{ str: item.str, x: x!, y: y!, width: item.width, height: item.height,
            rotation: Math.atan2(item.transform[1], item.transform[0]) }]
        })
        const text = orderResumePdfPage(positioned)
        pages.push(text)
        const operators = await page.getOperatorList()
        if (resumePdfPageNeedsOcr({ text, items: positioned,
          images: resumePdfImageRegions(operators, OPS, viewport.transform), width: viewport.width, height: viewport.height })) requiredPages.push(index)
      }
      const text = pages.join('\n\n')
      return !requiredPages.length && resumeBodyCharacterCount(text) >= 20 ? text : await recognizeWithOcr(content, filename, mimeType, pages, requiredPages.length ? requiredPages : pages.map((_,index)=>index+1), resolveBillingEnv)
    } finally { await task.destroy() }
  }
  if (['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'].includes(extension) || mimeType?.startsWith('image/')) {
    return recognizeWithOcr(content, filename, mimeType, undefined, undefined, resolveBillingEnv)
  }
  throw new Error(`Unsupported resume format: .${extension || 'unknown'}`)
}
