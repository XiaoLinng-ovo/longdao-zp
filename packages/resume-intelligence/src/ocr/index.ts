export const RESUME_OCR_TIMEOUT_MS = 180_000

/** New OCR servers return page identities so text-native pages stay lossless.
 * Older servers return a full-document text field and remain compatible. */
export function mergeResumeOcrPages(payload: { text?: unknown; pages?: unknown }, original: string[], requiredPages: number[]): string {
  if (!Array.isArray(payload.pages)) return typeof payload.text === 'string' ? payload.text : ''
  const texts = new Map<number, string>()
  for (const item of payload.pages) {
    if (!item || typeof item !== 'object') continue
    const row = item as { page?: unknown; text?: unknown }
    if (typeof row.page === 'number' && Number.isInteger(row.page) && typeof row.text === 'string') texts.set(row.page, row.text)
  }
  if (requiredPages.some((page) => !texts.get(page)?.trim())) throw new Error('OCR 未完整识别所有图片页，请检查原文件清晰度后重试。')
  return original.map((text, index) => requiredPages.includes(index + 1) ? texts.get(index + 1)! : text).join('\n\n')
}
