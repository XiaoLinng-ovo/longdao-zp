import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'
import { createHttpOcrClient, type OcrClient } from './ocr-client.js'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

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
    const parser = new PDFParse({ data: content })
    try {
      const result = await parser.getText()
      if (result.text.replace(/\s+/gu, '').length >= 20) return result.text
      if (!ocrClient) throw new Error('PDF contains too little embedded text and OCR_SERVICE_URL is not configured')
      return (await ocrClient.recognize({ content, filename, ...(mimeType ? { mimeType } : {}) })).text
    } finally {
      await parser.destroy()
    }
  }
  if (['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'].includes(extension) || mimeType?.startsWith('image/')) {
    if (!ocrClient) throw new Error('Image resume requires OCR_SERVICE_URL')
    return (await ocrClient.recognize({ content, filename, ...(mimeType ? { mimeType } : {}) })).text
  }
  throw new Error(`Unsupported resume format: .${extension || 'unknown'}`)
}
