/**
 * 把上游模型服务的失败响应整理成可诊断的文案。
 *
 * 只保留状态码与响应体摘要（截断 300 字），并抹掉可能出现在响应体里的 API Key。
 * 上游的 400 往往直接说明了原因（模型名不存在、参数不支持），丢掉它会让问题无从排查。
 */
function summarize(text: string, apiKey: string): string {
  const compact = text.replace(/\s+/gu, ' ').trim()
  const redacted = apiKey ? compact.split(apiKey).join('***') : compact
  return redacted.slice(0, 300)
}

export async function describeModelHttpFailure(response: Response, apiKey: string, label: string): Promise<string> {
  const detail = await response.text().catch(() => '')
  const summary = summarize(detail, apiKey)
  return `${label} returned HTTP ${response.status}${summary ? `：${summary}` : ''}`
}

/** Inspect the entire response instead of trusting HTTP 200 from a provider website. */
export async function readModelJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (/text\/html/iu.test(response.headers.get('content-type') ?? '') || /^\s*<(?:!doctype\s+html|html|head|body)\b/iu.test(text)) {
    throw new Error('模型服务返回了 HTML 网页，而不是 API 数据。请在 AI 模型设置中检查接口地址（通常应以 /v1 结尾），不要填写服务商网站页面。')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('模型服务返回的响应不是有效 JSON，请检查接口地址及模型服务状态。')
  }
}
