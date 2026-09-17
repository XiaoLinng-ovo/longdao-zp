export interface OcrClient {
  recognize(input: { content: Buffer; filename: string; mimeType?: string }): Promise<{ text: string; engine: string }>
}

export function createHttpOcrClient(baseUrl = process.env.OCR_SERVICE_URL ?? ''): OcrClient | undefined {
  if (!baseUrl.trim()) return undefined
  return {
    async recognize(input) {
      const form = new FormData()
      form.append('file', new Blob([Uint8Array.from(input.content)], { type: input.mimeType ?? 'application/octet-stream' }), input.filename)
      const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/ocr`, { method: 'POST', body: form })
      if (!response.ok) throw new Error(`OCR service returned HTTP ${response.status}`)
      const payload = await response.json() as { text?: unknown; engine?: unknown }
      if (typeof payload.text !== 'string' || !payload.text.trim()) throw new Error('OCR service returned empty text')
      return { text: payload.text, engine: typeof payload.engine === 'string' ? payload.engine : 'PP-StructureV3' }
    },
  }
}
