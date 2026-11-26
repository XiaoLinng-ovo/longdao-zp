import { RESUME_OCR_TIMEOUT_MS, resumeBodyCharacterCount, resumeTextHasEncodingDamage } from '@smartrecruit-pro/resume-intelligence'
import { meterOcrOperation } from '@smartrecruit-pro/enterprise-ai'

export interface OcrClient {
  recognize(input: { content: Buffer; filename: string; mimeType?: string; pages?: number[] }): Promise<{ text: string; engine: string; pages?: unknown }>
}
export function meteredOcrClient(client: OcrClient | undefined, resolveEnv: () => Promise<NodeJS.ProcessEnv>): OcrClient | undefined {
  if (!client) return undefined
  return { recognize: async input => meterOcrOperation(await resolveEnv(), input.content, input.pages, () => client.recognize(input)) }
}

export function createHttpOcrClient(baseUrl = process.env.OCR_SERVICE_URL ?? '', options: { fetch?: typeof fetch; timeoutMs?: number } = {}): OcrClient | undefined {
  if (!baseUrl.trim()) return undefined
  return {
    async recognize(input) {
      const form = new FormData()
      form.append('file', new Blob([Uint8Array.from(input.content)], { type: input.mimeType ?? 'application/octet-stream' }), input.filename)
      if (input.pages?.length) form.append('pages', JSON.stringify(input.pages))
      let response: Response
      let payload: { text?: unknown; engine?: unknown; pages?: unknown }
      try {
        response = await (options.fetch ?? fetch)(`${baseUrl.trim().replace(/\/$/u, '')}/ocr`, {
          method: 'POST', body: form, signal: AbortSignal.timeout(options.timeoutMs ?? RESUME_OCR_TIMEOUT_MS),
        })
        if (!response.ok) {
          await response.body?.cancel()
          throw Object.assign(new Error(`OCR 服务返回 HTTP ${response.status}`), {code:'OCR_HTTP_ERROR'})
        }
        payload = await response.json() as { text?: unknown; engine?: unknown; pages?: unknown }
      } catch (error) {
        throw Object.assign(new Error('OCR 识别服务未启动、连接失败或响应异常，请检查 OCR 服务；本次尚未生成评分。', { cause: error }), (error as {code?:string}).code==='OCR_HTTP_ERROR' ? {code:'OCR_HTTP_ERROR'} : {})
      }
      if (typeof payload?.text !== 'string' || resumeBodyCharacterCount(payload.text) < 5) throw new Error('OCR 未识别到有效简历正文，尚未生成评分；请检查原文件清晰度。')
      if (resumeTextHasEncodingDamage(payload.text)) throw new Error('OCR 结果仍存在明显乱码，尚未生成评分；请检查原文件清晰度或重新导出 PDF。')
      return { text: payload.text, engine: typeof payload.engine === 'string' ? payload.engine : 'PP-StructureV3', ...(Array.isArray(payload.pages) ? { pages: payload.pages } : {}) }
    },
  }
}
