import { loadQuestionSheetGeneratorConfig, QuestionSheetGenerationError } from './question-sheet-generator.js'
import type { CorrectedTranscriptTurn, TranscriptCorrection, TranscriptUncertainty } from './transcript-postprocessing.js'
import { simplifyTranscript } from './transcript-text.js'

export interface TranscriptContext {
  candidateName: string
  jobTitle: string
  requirements: string[]
  skills: string[]
}

export interface TranscriptContextCorrectionInput {
  turns: CorrectedTranscriptTurn[]
  context: TranscriptContext
}

export interface TranscriptContextCorrectionResult {
  turns: CorrectedTranscriptTurn[]
  corrections: TranscriptCorrection[]
  uncertainties: TranscriptUncertainty[]
  warnings: string[]
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface CorrectedItem {
  turnId: string
  text: string
  reason: string
}

interface UncertainItem {
  turnId: string
  reason: string
}

interface ParsedCorrection {
  corrections: CorrectedItem[]
  uncertainties: UncertainItem[]
}

interface CorrectionBatch {
  rows: CorrectedTranscriptTurn[]
  before: CorrectedTranscriptTurn[]
  after: CorrectedTranscriptTurn[]
}

type CorrectionProtocol = 'json' | 'marked'

class ModelOutputError extends Error {}
class ProviderResultMissingError extends Error {}
class ModelHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

const JSON_SYSTEM_PROMPT = [
  '你是中文面试转写校对器。只修正同音字、断句、标点和明确的领域术语，不得改写、概括、补写或删除事实。',
  '角色、时间、轮次数量均由系统保留；你不能修改。数字、金额、比例、日期、否定关系和候选人/公司/项目等专名必须原样保留。',
  '逐轮检查 turnsToCorrect。默认保留原文；只检查同音字、明确术语、断句和标点。没有明确错误就不要修改，也不要解释或延伸分析。',
  '只返回一个短 JSON 对象，结构固定为 {"corrections":[{"turnId":"原 turnId","text":"完整修正文本","reason":"十字以内原因"}],"uncertainties":[{"turnId":"原 turnId","reason":"二十字以内原因"}]}。',
  '没有修改时 corrections 为空数组，没有无法判断的内容时 uncertainties 为空数组。两个数组都必须返回；不要输出 Markdown、代码块或任何 JSON 之外的文字。',
].join('\n')

const MARKED_SYSTEM_PROMPT = [
  '你是中文面试转写校对器。只修正同音字、断句、标点和明确的领域术语，不得改写、概括、补写或删除事实。',
  '角色、时间、轮次数量均由系统保留；你不能修改。数字、金额、比例、日期、否定关系和候选人/公司/项目等专名必须原样保留。',
  '逐轮检查 turnsToCorrect。默认保留原文；只需考虑同音字、明确术语、断句和标点，确认无改动就立即结束该轮，不做延伸分析。',
  '修改使用以下纯文本格式：<<<TURN turnId>>>、下一行是完整修正文本、再下一行是 <<<END>>>。存疑使用：<<<UNCERTAIN turnId>>>、下一行是二十字以内的原因、再下一行是 <<<END>>>。',
  '不要输出 JSON、Markdown、代码块或分析过程。全部无需修改时，唯一输出必须恰好是 NO_CHANGES。',
].join('\n')

const JSON_RESPONSE_FORMAT = { type: 'json_object' } as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseJsonContent(content: string): unknown {
  const trimmed = content.replace(/^\uFEFF/u, '').trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim()
  const firstBrace = trimmed.indexOf('{'), lastBrace = trimmed.lastIndexOf('}')
  const embedded = firstBrace >= 0 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : undefined
  const candidates = [...new Set([trimmed, fenced, embedded].filter((item): item is string => Boolean(item)))]
  const objectCandidate = firstBrace >= 0 ? trimmed.slice(firstBrace) : ''
  if (needsOnlyTopLevelObjectClose(objectCandidate)) candidates.push(`${objectCandidate}}`)
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (typeof parsed === 'string') {
        try { return JSON.parse(parsed) } catch { /* Retry the extracted object below. */ }
      }
      return parsed
    } catch { /* Try the next safe candidate. */ }
  }
  throw new ModelOutputError('模型没有返回合法 JSON，已保留该批原始转写。')
}

/** Recover only a complete JSON payload missing its final top-level close. */
function needsOnlyTopLevelObjectClose(value: string): boolean {
  if (!value.startsWith('{') || value.endsWith('}')) return false
  const stack: string[] = []
  let inString = false, escaped = false
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') stack.push('}')
    else if (character === '[') stack.push(']')
    else if (character === '}' || character === ']') {
      if (stack.pop() !== character) return false
    }
  }
  return !inString && stack.length === 1 && stack[0] === '}'
}

function parseJsonCorrectionContent(content: string, allowedIds: Set<string>): ParsedCorrection {
  const value = parseJsonContent(content)
  if (!isRecord(value)) throw new ModelOutputError('模型没有返回 JSON 对象，已保留该批原始转写。')
  const rawCorrections = Array.isArray(value.corrections) ? value.corrections : value.turns
  if (!Array.isArray(rawCorrections)) throw new ModelOutputError('模型 JSON 缺少 corrections 数组，已保留该批原始转写。')
  const seen = new Set<string>()
  const corrections: CorrectedItem[] = rawCorrections.map((item): CorrectedItem => {
    if (!isRecord(item)) throw new ModelOutputError('模型 corrections 中存在非法条目。')
    const turnId = text(item.turnId), corrected = text(item.text), reason = text(item.reason) ?? '上下文术语或同音字校正'
    if (!turnId || !allowedIds.has(turnId) || seen.has(turnId) || !corrected) {
      throw new ModelOutputError('模型返回了未知、重复或不完整的轮次。')
    }
    seen.add(turnId)
    return { turnId, text: corrected, reason }
  })
  const uncertainties: UncertainItem[] = []
  if (value.uncertainties !== undefined) {
    if (!Array.isArray(value.uncertainties)) throw new ModelOutputError('模型 uncertainties 必须为数组。')
    for (const item of value.uncertainties) {
      if (!isRecord(item)) throw new ModelOutputError('模型 uncertainties 中存在非法条目。')
      const turnId = text(item.turnId), reason = text(item.reason)
      if (!turnId || !allowedIds.has(turnId) || !reason) throw new ModelOutputError('模型返回了未知或不完整的不确定说明。')
      uncertainties.push({ turnId, reason })
    }
  }
  return { corrections, uncertainties }
}

function parseCorrectionContent(content: string, allowedIds: Set<string>, protocol: CorrectionProtocol): ParsedCorrection {
  if (/(?:^|\n)\s*NO_CHANGES\s*$/u.test(content.trim())) return { corrections: [], uncertainties: [] }
  if (protocol === 'json') return parseJsonCorrectionContent(content, allowedIds)
  const marked = parseMarkedContent(content, allowedIds)
  if (!marked) throw new ModelOutputError('模型没有返回可识别的轮次标记，已保留该批原始转写。')
  return marked
}

function parseAnyCorrectionContent(content: string, allowedIds: Set<string>): ParsedCorrection {
  const marked = parseMarkedContent(content, allowedIds)
  return marked ?? parseJsonCorrectionContent(content, allowedIds)
}

function hasMarkedResult(content: string | undefined): boolean {
  return Boolean(content && (/(?:^|\n)\s*NO_CHANGES\s*$/u.test(content.trim()) || /<<<(?:TURN|UNCERTAIN)\s+[^\s>]+>>>/u.test(content)))
}

/**
 * Compatible gateways sometimes stop a no-change answer after only an ASCII
 * prefix, or leave the final decision in reasoning_content. Only recover an
 * explicit terminal no-change conclusion; never infer a real correction here.
 */
const TRUNCATED_NO_CHANGES_PREFIXES = new Set([
  'N', 'NO', 'NO_', 'NO_C', 'NO_CH', 'NO_CHA', 'NO_CHAN', 'NO_CHANG', 'NO_CHANGE',
])

function reasoningConfirmsNoChanges(reasoning: string): boolean {
  const tail = reasoning.trim().slice(-800)
  return /(?:output|return|answer|final(?:ly)?|thus|so|最终|所以|因此)?\s*NO_CHANGES[.。]?\s*$/iu.test(tail)
    || /(?:无需|不需要|不用)(?:再)?(?:做)?(?:修改|改动)[。.!！]?\s*$/u.test(tail)
    || /(?:没有|无)(?:明确)?(?:错误|改动)[。.!！]?\s*$/u.test(tail)
    || /(?:no (?:changes?|corrections?) (?:are )?(?:needed|required)|nothing to (?:change|correct))[.!]?\s*$/iu.test(tail)
}

function isTruncatedNoChangesPrefix(content: string | undefined, reasoning: string | undefined): boolean {
  if (!content || !TRUNCATED_NO_CHANGES_PREFIXES.has(content.trim().toUpperCase()) || !reasoning) return false
  return reasoningConfirmsNoChanges(reasoning)
}

function parseCorrectionMessage(content: string | undefined, reasoning: string | undefined,
  allowedIds: Set<string>, protocol: CorrectionProtocol): ParsedCorrection {
  if (isTruncatedNoChangesPrefix(content, reasoning)) return { corrections: [], uncertainties: [] }
  if (content) return parseCorrectionContent(content, allowedIds, protocol)
  if (reasoning && reasoningConfirmsNoChanges(reasoning)) return { corrections: [], uncertainties: [] }
  if (reasoning && hasMarkedResult(reasoning)) return parseAnyCorrectionContent(reasoning, allowedIds)
  throw new ProviderResultMissingError('模型只返回了分析过程，没有返回校对结果，已保留原文。')
}

function parseMarkedContent(content: string, allowedIds: Set<string>): ParsedCorrection | undefined {
  const trimmed = content.replace(/^\uFEFF/u, '').trim()
  if (/(?:^|\n)\s*NO_CHANGES\s*$/u.test(trimmed)) return { corrections: [], uncertainties: [] }

  const corrections: CorrectedItem[] = []
  const uncertainties: UncertainItem[] = []
  const seenCorrections = new Set<string>()
  const seenUncertainties = new Set<string>()
  const pattern = /<<<(TURN|UNCERTAIN)\s+([^\s>]+)>>>\s*([\s\S]*?)\s*<<<END>>>/gu
  for (const match of trimmed.matchAll(pattern)) {
    const kind = match[1], turnId = match[2], body = match[3]?.trim() ?? ''
    if (!turnId || !allowedIds.has(turnId) || !body) throw new ModelOutputError('模型返回了未知或不完整的轮次。')
    if (kind === 'TURN') {
      if (seenCorrections.has(turnId)) throw new ModelOutputError('模型返回了重复的修正轮次。')
      seenCorrections.add(turnId)
      corrections.push({ turnId, text: body, reason: '上下文术语或同音字校对' })
    } else {
      if (seenUncertainties.has(turnId)) throw new ModelOutputError('模型返回了重复的不确定轮次。')
      seenUncertainties.add(turnId)
      uncertainties.push({ turnId, reason: body.slice(0, 200) })
    }
  }
  if (!corrections.length && !uncertainties.length) return undefined

  const outsideMarkers = trimmed.replace(pattern, '').trim()
  if (outsideMarkers) throw new ModelOutputError('模型在轮次标记之外返回了无法识别的内容。')
  return { corrections, uncertainties }
}

function protectedTokens(value: string): { numbers: string[]; negations: string[]; names: string[] } {
  const normalized = value.normalize('NFKC')
  const numbers = normalized.match(/\d+(?:[.,]\d+)*(?:%|元|万元|亿元|年|月|日|天|小时|分钟|秒|人|个|次|家|项|倍)?/gu) ?? []
  const negations = normalized.match(/并非|不是|不会|不能|不要|没有|未能|从未|并不|并未|无需|未|没(?!错)/gu) ?? []
  const names = normalized.match(/[\p{Script=Han}A-Za-z0-9·_-]{2,16}(?:股份有限公司|有限责任公司|有限公司|公司|集团|大学|学院|项目|平台|系统|产品)/gu) ?? []
  return { numbers, negations, names }
}

function preservesProtectedContent(original: string, corrected: string, context: TranscriptContext): boolean {
  const before = protectedTokens(original), after = protectedTokens(corrected)
  if (JSON.stringify(before.numbers) !== JSON.stringify(after.numbers)) return false
  if (JSON.stringify(before.negations) !== JSON.stringify(after.negations)) return false
  for (const name of before.names) if (!corrected.includes(name)) return false
  for (const name of [context.candidateName, context.jobTitle]) {
    if (name.trim().length >= 2 && original.includes(name) && !corrected.includes(name)) return false
  }
  return true
}

function batches(turns: CorrectedTranscriptTurn[], maxTurns = 4, maxChars = 1500): CorrectionBatch[] {
  const result: CorrectionBatch[] = []
  let start = 0
  while (start < turns.length) {
    let end = start, chars = 0
    while (end < turns.length && end - start < maxTurns && (end === start || chars + turns[end]!.text.length <= maxChars)) {
      chars += turns[end]!.text.length
      end++
    }
    result.push({ rows: turns.slice(start, end), before: turns.slice(Math.max(0, start - 2), start), after: turns.slice(end, Math.min(turns.length, end + 2)) })
    start = end
  }
  return result
}

function isTransientCorrectionFailure(error: unknown): boolean {
  if (error instanceof ModelHttpError) return error.status === 429 || error.status >= 500
  return error instanceof TypeError || error instanceof SyntaxError
    || error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function shouldFallbackToMarkedProtocol(error: unknown): boolean {
  return error instanceof ModelOutputError || error instanceof ProviderResultMissingError
    || error instanceof ModelHttpError && (error.status === 400 || error.status === 422)
}

function isCorrectionOutputFailure(error: unknown): boolean {
  return error instanceof ModelOutputError || error instanceof ProviderResultMissingError
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function dialogueRows(rows: CorrectedTranscriptTurn[]): Array<{ turnId: string; role: string; text: string }> {
  return rows.map(row => ({ turnId: row.id, role: row.role, text: row.text }))
}

function fallbackResult(turns: CorrectedTranscriptTurn[], warnings: string[]): TranscriptContextCorrectionResult {
  return {
    turns: turns.map(turn => ({ ...turn, text: simplifyTranscript(turn.text) })),
    corrections: [], uncertainties: [], warnings,
  }
}

function correctionFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (/aborted due to timeout|timed?\s*out|timeout/iu.test(detail)) return '模型校对请求超时，已保留该批原始转写。'
  return detail
}

export class TranscriptContextCorrector {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  private async requestCorrectionBatch(config: ReturnType<typeof loadQuestionSheetGeneratorConfig>,
    input: TranscriptContextCorrectionInput, batch: CorrectionBatch,
    protocol: CorrectionProtocol): Promise<ParsedCorrection> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.requestCorrectionBatchAttempt(config, input, batch, protocol)
      } catch (error) {
        if (!isTransientCorrectionFailure(error) || attempt >= 3) throw error
        await wait(250 * attempt)
      }
    }
  }

  private async requestCorrectionBatchAttempt(config: ReturnType<typeof loadQuestionSheetGeneratorConfig>,
    input: TranscriptContextCorrectionInput, batch: CorrectionBatch,
    protocol: CorrectionProtocol): Promise<ParsedCorrection> {
    const response = await this.fetchImpl(`${config.baseUrl.replace(/\/$/u, '')}/chat/completions`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        max_completion_tokens: 4096,
        ...(/deepseek/iu.test(config.model) ? { thinking: { type: 'disabled' } } : {}),
        ...(protocol === 'json' ? { response_format: JSON_RESPONSE_FORMAT } : {}),
        messages: [
          { role: 'system', content: protocol === 'json' ? JSON_SYSTEM_PROMPT : MARKED_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({
            job: { title: input.context.jobTitle, requirements: input.context.requirements, skills: input.context.skills },
            candidate: { name: input.context.candidateName },
            previousContext: dialogueRows(batch.before),
            turnsToCorrect: dialogueRows(batch.rows),
            nextContext: dialogueRows(batch.after),
          }) },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    if (!response.ok) throw new ModelHttpError(`模型请求失败（HTTP ${response.status}），已保留该批原始转写。`, response.status)
    let body: unknown
    try { body = await response.json() }
    catch { throw new ModelOutputError('模型响应不是合法 JSON，已保留该批原始转写。') }
    if (!isRecord(body) || !Array.isArray(body.choices)) throw new ModelOutputError('模型响应缺少 choices。')
    const message = body.choices[0]
    const finalContent = isRecord(message) && isRecord(message.message)
      ? text(message.message.content)
      : undefined
    const reasoningContent = isRecord(message) && isRecord(message.message)
      ? text(message.message.reasoning_content)
      : undefined
    return parseCorrectionMessage(finalContent, reasoningContent,
      new Set(batch.rows.map(row => row.id)), protocol)
  }

  private async correctBatch(config: ReturnType<typeof loadQuestionSheetGeneratorConfig>,
    input: TranscriptContextCorrectionInput, batch: CorrectionBatch, splitDepth = 0): Promise<ParsedCorrection> {
    try {
      return await this.requestCorrectionBatch(config, input, batch, 'json')
    } catch (jsonError) {
      if (!shouldFallbackToMarkedProtocol(jsonError)) throw jsonError
      try {
        return await this.requestCorrectionBatch(config, input, batch, 'marked')
      } catch (markedError) {
        const recoveryError = isCorrectionOutputFailure(markedError) ? markedError : jsonError
        if (isCorrectionOutputFailure(recoveryError) && batch.rows.length > 1 && splitDepth === 0) {
          return this.splitAndCorrectBatch(config, input, batch, splitDepth + 1)
        }
        if (isCorrectionOutputFailure(recoveryError)) {
          const reason = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          return { corrections: [], uncertainties: batch.rows.map(row => ({ turnId: row.id, reason })) }
        }
        throw markedError
      }
    }
  }

  private async splitAndCorrectBatch(config: ReturnType<typeof loadQuestionSheetGeneratorConfig>,
    input: TranscriptContextCorrectionInput, batch: CorrectionBatch, splitDepth: number): Promise<ParsedCorrection> {
    const midpoint = Math.ceil(batch.rows.length / 2)
    const left: CorrectionBatch = { rows: batch.rows.slice(0, midpoint), before: batch.before, after: batch.rows.slice(midpoint, midpoint + 2) }
    const right: CorrectionBatch = { rows: batch.rows.slice(midpoint), before: batch.rows.slice(Math.max(0, midpoint - 2), midpoint), after: batch.after }
    const first = await this.correctBatch(config, input, left, splitDepth)
    const second = await this.correctBatch(config, input, right, splitDepth)
    return { corrections: [...first.corrections, ...second.corrections], uncertainties: [...first.uncertainties, ...second.uncertainties] }
  }

  async correct(input: TranscriptContextCorrectionInput, env: NodeJS.ProcessEnv = process.env): Promise<TranscriptContextCorrectionResult> {
    if (!input.turns.length) return fallbackResult(input.turns, [])
    let config
    try { config = loadQuestionSheetGeneratorConfig(env) }
    catch (error) {
      const detail = error instanceof QuestionSheetGenerationError ? error.message : String(error)
      return fallbackResult(input.turns, [`企业模型未配置，已发布不做语义改写的确定性整理版：${detail}`])
    }

    const output = input.turns.map(turn => ({ ...turn, text: simplifyTranscript(turn.text) }))
    const byId = new Map(output.map(turn => [turn.id, turn]))
    const corrections: TranscriptCorrection[] = []
    const uncertainties: TranscriptUncertainty[] = []
    const warnings: string[] = []
    for (const batch of batches(output)) {
      let parsed: ParsedCorrection
      try {
        parsed = await this.correctBatch(config, input, batch)
      } catch (error) {
        const warning = correctionFailureMessage(error)
        warnings.push(warning)
        const reason = warning.includes('超时')
          ? '模型校对请求超时，这一轮未完成上下文校对，已保留原文。'
          : `这一轮未完成上下文校对，已保留原文：${warning}`
        for (const turn of batch.rows) uncertainties.push({ turnId: turn.id, original: turn.text, reason })
        continue
      }
      for (const item of parsed.corrections) {
        const turn = byId.get(item.turnId)!
        const candidate = simplifyTranscript(item.text)
        if (candidate.length > Math.max(turn.text.length * 2, turn.text.length + 80)) {
          uncertainties.push({ turnId: turn.id, original: turn.text, reason: '模型给出的文本长度异常，已保留原文。' })
          continue
        }
        if (!preservesProtectedContent(turn.text, candidate, input.context)) {
          uncertainties.push({ turnId: turn.id, original: turn.text, reason: '模型改动涉及数字、日期、否定关系或专名，已保留原文。' })
          continue
        }
        if (candidate !== turn.text) {
          corrections.push({ turnId: turn.id, original: turn.text, corrected: candidate, reason: item.reason })
          turn.text = candidate
        }
      }
      for (const item of parsed.uncertainties) {
        const turn = byId.get(item.turnId)!
        uncertainties.push({ turnId: turn.id, original: turn.text, reason: item.reason })
      }
    }
    return { turns: output, corrections, uncertainties, warnings }
  }
}

export function createConfiguredTranscriptContextCorrector(): TranscriptContextCorrector {
  return new TranscriptContextCorrector()
}
