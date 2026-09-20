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
