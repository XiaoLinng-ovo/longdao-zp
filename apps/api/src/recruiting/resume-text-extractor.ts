import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { orderResumePdfPage, resumeBodyCharacterCount, resumePdfImageRegions, resumePdfPageNeedsOcr, resumeTextHasEncodingDamage } from '@smartrecruit-pro/resume-intelligence'
import mammoth from 'mammoth'
import { createHttpOcrClient, type OcrClient } from './ocr-client.js'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PDFJS_ROOT = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')).replaceAll('\\', '/')

async function recognize(content: Buffer, filename: string, mimeType: string | undefined, ocrClient: OcrClient | undefined): Promise<string> {
  if (!ocrClient) throw new Error('简历包含图片正文，需要 OCR 识别，但 OCR_SERVICE_URL 未配置。')
  const { text } = await ocrClient.recognize({ content, filename, ...(mimeType ? { mimeType } : {}) })
  if (resumeBodyCharacterCount(text) < 5) throw new Error('OCR 未识别到有效简历正文，尚未生成评分；请检查原文件清晰度。')
  if (resumeTextHasEncodingDamage(text)) throw new Error('OCR 结果仍存在明显乱码，尚未生成评分；请检查原文件清晰度或重新导出 PDF。')
  return text
}

/** Extract human-readable resume text without ever decoding binary formats as UTF-8. */
export async function extractResumeText(content: Buffer, filename: string, mimeType?: string, ocrClient: OcrClient | undefined = createHttpOcrClient()): Promise<string> {
  const extension = filename.toLowerCase().split('.').pop() ?? ''
  if (extension === 'txt' || extension === 'md') {
    if (mimeType && !mimeType.startsWith('text/')) throw new Error(`Resume MIME/extension mismatch: ${mimeType}`)
    return content.toString('utf8')
  }
  if (extension === 'docx' || mimeType === DOCX_MIME) {
    if (extension !== 'docx') throw new Error('DOCX filename extension is required')
    const result = await mammoth.extractRawText({ buffer: content })
    return result.value
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
      let needsOcr = false
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
        needsOcr ||= resumePdfPageNeedsOcr({ text, items: positioned,
          images: resumePdfImageRegions(operators, OPS, viewport.transform), width: viewport.width, height: viewport.height })
      }
      const text = pages.join('\n\n')
      if (!needsOcr && resumeBodyCharacterCount(text) >= 20) return text
      return await recognize(content, filename, mimeType, ocrClient)
    } finally {
      await task.destroy()
    }
  }
  if (['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'].includes(extension) || mimeType?.startsWith('image/')) {
    return recognize(content, filename, mimeType, ocrClient)
  }
  throw new Error(`Unsupported resume format: .${extension || 'unknown'}`)
}
