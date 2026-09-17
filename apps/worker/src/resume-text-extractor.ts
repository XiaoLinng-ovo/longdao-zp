import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

async function recognizeWithOcr(content: Buffer, filename: string, mimeType?: string): Promise<string> {
  const baseUrl = process.env.OCR_SERVICE_URL?.trim()
  if (!baseUrl) throw new Error('Resume requires OCR but OCR_SERVICE_URL is not configured')
  const form = new FormData()
  form.append('file', new Blob([Uint8Array.from(content)], { type: mimeType ?? 'application/octet-stream' }), filename)
  const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/ocr`, { method: 'POST', body: form })
  if (!response.ok) throw new Error(`OCR service returned HTTP ${response.status}`)
  const payload = await response.json() as { text?: unknown }
  if (typeof payload.text !== 'string' || !payload.text.trim()) throw new Error('OCR service returned empty text')
  return payload.text
}

export async function extractResumeText(content: Buffer, filename: string, mimeType?: string): Promise<string> {
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
    const parser = new PDFParse({ data: content })
    try {
      const text = (await parser.getText()).text
      return text.replace(/\s+/gu, '').length >= 20 ? text : recognizeWithOcr(content, filename, mimeType)
    } finally { await parser.destroy() }
  }
  if (['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'].includes(extension) || mimeType?.startsWith('image/')) {
    return recognizeWithOcr(content, filename, mimeType)
  }
  throw new Error(`Unsupported resume format: .${extension || 'unknown'}`)
}
