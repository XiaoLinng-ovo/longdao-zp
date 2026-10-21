import { resumeBodyCharacterCount, resumeTextHasEncodingDamage } from '@smartrecruit-pro/resume-intelligence'

export interface OcrClient {
  recognize(input: { content: Buffer; filename: string; mimeType?: string }): Promise<{ text: string; engine: string }>
}

export function createHttpOcrClient(baseUrl = process.env.OCR_SERVICE_URL ?? '', options: { fetch?: typeof fetch; timeoutMs?: number } = {}): OcrClient | undefined {
  if (!baseUrl.trim()) return undefined
  return {
    async recognize(input) {
      const form = new FormData()
      form.append('file', new Blob([Uint8Array.from(input.content)], { type: input.mimeType ?? 'application/octet-stream' }), input.filename)
      let response: Response
      let payload: { text?: unknown; engine?: unknown }
      try {
        response = await (options.fetch ?? fetch)(`${baseUrl.trim().replace(/\/$/u, '')}/ocr`, {
          method: 'POST', body: form, signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
        })
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error(`OCR 服务返回 HTTP ${response.status}`)
        }
        payload = await response.json() as { text?: unknown; engine?: unknown }
      } catch (error) {
        throw new Error('OCR 识别服务未启动、连接失败或响应异常，请检查 OCR 服务；本次尚未生成评分。', { cause: error })
      }
      if (typeof payload?.text !== 'string' || resumeBodyCharacterCount(payload.text) < 5) throw new Error('OCR 未识别到有效简历正文，尚未生成评分；请检查原文件清晰度。')
      if (resumeTextHasEncodingDamage(payload.text)) throw new Error('OCR 结果仍存在明显乱码，尚未生成评分；请检查原文件清晰度或重新导出 PDF。')
      return { text: payload.text, engine: typeof payload.engine === 'string' ? payload.engine : 'PP-StructureV3' }
    },
  }
}
