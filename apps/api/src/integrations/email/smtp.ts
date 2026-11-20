import { readEnvValues, resolveEnvFilePath, writeEnvFile } from '../../admin/env-file.js'
import nodemailer from 'nodemailer'
import sanitizeHtml from 'sanitize-html'

export const SMTP_ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'] as const
export type SmtpEnvKey = typeof SMTP_ENV_KEYS[number]
export type SmtpEnvPatch = Partial<Record<SmtpEnvKey, string>>
export interface SmtpEnvSetting { value: string; configured: boolean; masked: boolean }
export type SmtpEnvSettings = Record<SmtpEnvKey, SmtpEnvSetting>
export interface SmtpConnectionResult { ok: boolean; message: string }
export interface PdfMailAttachment { filename: string; content: Buffer }

const SECRET_KEYS = new Set<SmtpEnvKey>(['SMTP_PASSWORD'])
const MAX_PDF_BYTES = 10 * 1024 * 1024

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function mask(value: string): string { return !value ? '' : value.length <= 4 ? '••••' : `${value.slice(0, 2)}••••${value.slice(-2)}` }
function parsePort(value: string): number { const port = Number(value); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT 必须是 1 至 65535 的整数'); return port }
function parseBoolean(value: string): boolean { if (value.toLowerCase() === 'true') return true; if (value.toLowerCase() === 'false') return false; throw new Error('SMTP_SECURE 必须为 true 或 false') }
function validateNoNewline(value: string, key: string): void { if (/\r|\n/u.test(value)) throw new Error(`${key} 不能包含换行符`) }

async function savedValues(filePath: string, env: NodeJS.ProcessEnv = process.env): Promise<Record<SmtpEnvKey, string>> {
  const fileValues = await readEnvValues(filePath)
  return Object.fromEntries(SMTP_ENV_KEYS.map((key) => [key, text(fileValues.get(key)) || text(env[key])])) as Record<SmtpEnvKey, string>
}
function settingsFrom(values: Record<SmtpEnvKey, string>): { host: string; port: number; secure: boolean; user: string; password: string; from: string } {
  for (const key of SMTP_ENV_KEYS) if (!values[key]) throw new Error(`请先配置 ${key}`)
  const from = values.SMTP_FROM
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(from) && !/<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/u.test(from)) throw new Error('SMTP_FROM 必须是有效的发件邮箱或“显示名 <邮箱>”')
  return { host: values.SMTP_HOST, port: parsePort(values.SMTP_PORT), secure: parseBoolean(values.SMTP_SECURE), user: values.SMTP_USER, password: values.SMTP_PASSWORD, from }
}
function createTransport(values: Record<SmtpEnvKey, string>) { const settings = settingsFrom(values); return nodemailer.createTransport({ host: settings.host, port: settings.port, secure: settings.secure, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000, auth: { user: settings.user, pass: settings.password } }) }

export async function readSmtpEnvSettings(filePath = resolveEnvFilePath()): Promise<SmtpEnvSettings> {
  const values = await savedValues(filePath)
  return Object.fromEntries(SMTP_ENV_KEYS.map((key) => { const value = text(values[key]); return [key, { value: SECRET_KEYS.has(key) ? mask(value) : value, configured: Boolean(value), masked: SECRET_KEYS.has(key) }] })) as SmtpEnvSettings
}

export async function updateSmtpEnvSettings(filePath = resolveEnvFilePath(), patch: SmtpEnvPatch): Promise<SmtpEnvSettings> {
  for (const [key, value] of Object.entries(patch)) { if (!(SMTP_ENV_KEYS as readonly string[]).includes(key)) throw new Error(`不支持的 SMTP 配置项：${key}`); if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`); validateNoNewline(value, key) }
  settingsFrom({ ...(await savedValues(filePath)), ...patch } as Record<SmtpEnvKey, string>)
  await writeEnvFile(filePath, patch)
  for (const [key, value] of Object.entries(patch)) process.env[key] = value
  return readSmtpEnvSettings(filePath)
}

export async function testSmtpConnection(patch: SmtpEnvPatch = {}, env: NodeJS.ProcessEnv = process.env, filePath = resolveEnvFilePath()): Promise<SmtpConnectionResult> {
  try { await createTransport({ ...(await savedValues(filePath, env)), ...patch } as Record<SmtpEnvKey, string>).verify(); return { ok: true, message: 'SMTP 连接正常' } }
  catch (error) { return { ok: false, message: `SMTP 连接失败：${error instanceof Error ? error.message : '未知错误'}` } }
}

export function decodePdfAttachment(input: unknown): PdfMailAttachment | undefined {
  if (input === undefined || input === null) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('附件格式无效')
  const record = input as Record<string, unknown>; const filename = text(record.filename); const mimeType = text(record.mimeType).toLowerCase(); const content = text(record.content)
  if (!filename || !/^[^\\/\x00-\x1f]+\.pdf$/iu.test(filename)) throw new Error('附件必须是 PDF 文件')
  if (mimeType !== 'application/pdf') throw new Error('附件 MIME 类型必须是 application/pdf')
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(content) || content.length % 4 !== 0) throw new Error('PDF 附件编码无效')
  const buffer = Buffer.from(content, 'base64')
  if (!buffer.length || buffer.length > MAX_PDF_BYTES) throw new Error('PDF 附件大小必须在 1 字节至 10 MiB 之间')
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('附件不是有效的 PDF 文件')
  return { filename, content: buffer }
}

function escapeHtml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;') }
function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/gu, '<code style="font-family:Consolas,\'Courier New\',monospace;font-size:13px;background:#f3f4f6;padding:1px 4px;border-radius:3px;">$1</code>')
    .replace(/\*\*([^*]+)\*\*/gu, '<strong style="font-weight:700;color:#172033;">$1</strong>')
    .replace(/_([^_]+)_/gu, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu, '<a href="$2" style="color:#2563eb;text-decoration:underline;">$1</a>')
}

const EMAIL_STYLES = {
  body: 'margin:0;padding:0;color:#263044;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'Microsoft YaHei\',Arial,sans-serif;font-size:17px;line-height:1.9;',
  container: 'max-width:760px;margin:0 auto;padding:12px 8px 28px;box-sizing:border-box;',
  heading1: 'margin:0 0 30px;text-align:center;color:#172033;font-size:32px;line-height:1.4;font-weight:700;',
  heading2: 'margin:34px 0 16px;padding-bottom:8px;color:#172033;font-size:19px;line-height:1.55;font-weight:700;border-bottom:1px solid #dfe5ec;',
  heading3: 'margin:26px 0 12px;color:#172033;font-size:18px;line-height:1.55;font-weight:700;',
  paragraph: 'margin:0 0 16px;text-indent:2em;',
  list: 'margin:0 0 20px;padding-left:30px;',
  listItem: 'margin:0 0 10px;padding-left:2px;',
} as const

const EMAIL_ROLE_STYLES: Record<string, string> = {
  'candidate-greeting': 'margin:0 0 16px;text-indent:0;',
  'onboarding-materials': 'margin:0 0 16px;text-indent:0;',
}

/** Restricted Markdown rendering for mail content. Raw HTML is always escaped. */
export function renderMarkdownEmail(markdown: string): string {
  const blocks: string[] = []; let list: string[] = []; let listType: 'ul' | 'ol' | undefined
  const flushList = () => {
    if (!list.length || !listType) return
    blocks.push(`<${listType} style="${EMAIL_STYLES.list}">${list.map((item) => `<li style="${EMAIL_STYLES.listItem}">${inlineMarkdown(item)}</li>`).join('')}</${listType}>`)
    list = []; listType = undefined
  }
  for (const raw of markdown.replace(/\r\n?/gu, '\n').split('\n')) {
    const line = raw.trim(); const heading = line.match(/^(#{1,3})\s+(.+)$/u); const chineseHeading = line.match(/^(?:[一二三四五六七八九十百]+、|[（(][一二三四五六七八九十百]+[）)])/u); const unorderedItem = line.match(/^[-*]\s+(.+)$/u); const orderedItem = line.match(/^\d+[.)、]\s+(.+)$/u)
    const nextListType = unorderedItem ? 'ul' : orderedItem ? 'ol' : undefined
    if (nextListType) {
      if (listType && listType !== nextListType) flushList()
      listType = nextListType
      list.push((unorderedItem ?? orderedItem)![1]!)
      continue
    }
    flushList(); if (!line) continue
    if (heading) {
      const level = heading[1]!.length
      const style = level === 1 ? EMAIL_STYLES.heading1 : level === 2 ? EMAIL_STYLES.heading2 : EMAIL_STYLES.heading3
      blocks.push(`<h${level} style="${style}">${inlineMarkdown(heading[2]!)}</h${level}>`)
    } else if (chineseHeading) {
      blocks.push(`<h2 style="${EMAIL_STYLES.heading2}">${inlineMarkdown(line)}</h2>`)
    } else if (/^录用通知书[：:]?$/u.test(line)) {
      blocks.push(`<h1 style="${EMAIL_STYLES.heading1}">${inlineMarkdown(line)}</h1>`)
    } else blocks.push(`<p style="${EMAIL_STYLES.paragraph}">${inlineMarkdown(line)}</p>`)
  }
  flushList(); return `<div style="${EMAIL_STYLES.body}"><div style="${EMAIL_STYLES.container}">${blocks.join('')}</div></div>`
}

const EMAIL_TAG_STYLES = {
  p: EMAIL_STYLES.paragraph,
  h1: EMAIL_STYLES.heading1,
  h2: EMAIL_STYLES.heading2,
  h3: EMAIL_STYLES.heading3,
  ul: EMAIL_STYLES.list,
  ol: EMAIL_STYLES.list,
  li: EMAIL_STYLES.listItem,
  strong: 'font-weight:700;color:#172033;',
  em: 'font-style:italic;',
  u: 'text-decoration:underline;',
  blockquote: 'margin:18px 0;padding:10px 16px;border-left:3px solid #aab8c8;background:#f7f9fb;color:#475569;',
  code: 'padding:2px 5px;border-radius:3px;background:#f1f5f9;color:#334155;font-family:Consolas,\'Courier New\',monospace;font-size:14px;',
  pre: 'margin:18px 0;padding:14px;overflow:auto;border-radius:6px;background:#f1f5f9;color:#334155;font-family:Consolas,\'Courier New\',monospace;font-size:14px;line-height:1.7;white-space:pre-wrap;',
  hr: 'margin:28px 0;border:0;border-top:1px solid #dfe5ec;',
} as const

/** Removes unsafe markup and applies email-client-safe inline styles. */
export function sanitizeRichEmailHtml(html: string): string {
  const transform = (tagName: keyof typeof EMAIL_TAG_STYLES) => (_tagName: string, attribs: Record<string, string>) => ({
    tagName,
    attribs: { ...attribs, style: EMAIL_ROLE_STYLES[attribs['data-offer-role'] ?? ''] ?? EMAIL_TAG_STYLES[tagName] },
  })
  return sanitizeHtml(html, {
    allowedTags: ['p', 'h1', 'h2', 'h3', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'br', 'blockquote', 'a', 'code', 'pre', 'hr'],
    allowedAttributes: { a: ['href', 'title'], '*': ['style', 'data-offer-role'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    disallowedTagsMode: 'discard',
    transformTags: {
      p: transform('p'), h1: transform('h1'), h2: transform('h2'), h3: transform('h3'),
      ul: transform('ul'), ol: transform('ol'), li: transform('li'), strong: transform('strong'),
      em: transform('em'), u: transform('u'), blockquote: transform('blockquote'), code: transform('code'),
      pre: transform('pre'), hr: transform('hr'),
      // Reference spans can come directly from the editor, not only from the
      // frontend's resolved HTML. Persist emphasis in email-client-safe markup.
      span: (_tagName, attribs) => attribs['data-offer-variable']
        ? { tagName: 'u', attribs: { style: EMAIL_TAG_STYLES.u } }
        : { tagName: 'span', attribs: {} },
      a: (_tagName, attribs) => ({ tagName: 'a', attribs: { ...attribs, style: 'color:#2563eb;text-decoration:underline;' } }),
    },
  }).trim()
}

export function renderRichEmailHtml(html: string): string {
  const content = sanitizeRichEmailHtml(html)
  return `<div style="${EMAIL_STYLES.body}"><div style="${EMAIL_STYLES.container}">${content}</div></div>`
}

function htmlToPlainText(html: string): string {
  const withLineBreaks = html
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(?:p|h[1-6]|li|blockquote|pre)>/giu, '\n')
    .replace(/<li[^>]*>/giu, '- ')
  return sanitizeHtml(withLineBreaks, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

export async function sendSmtpMail(input: { to: string; subject: string; markdown?: string; html?: string; messageId?: string; attachment?: PdfMailAttachment }, env: NodeJS.ProcessEnv = process.env, filePath = resolveEnvFilePath()): Promise<void> {
  const to = text(input.to); const subject = text(input.subject)
  const markdown = text(input.markdown); const html = text(input.html)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(to)) throw new Error('收件人邮箱格式无效')
  if (!subject || subject.length > 200 || /\r|\n/u.test(subject)) throw new Error('邮件主题不能为空且不能包含换行符')
  if (!html && !markdown) throw new Error('邮件正文不能为空')
  if ((html || markdown).length > 50_000) throw new Error('邮件正文不能超过 50000 个字符')
  if (input.messageId && !/^<[a-zA-Z0-9.@-]+>$/u.test(input.messageId)) throw new Error('邮件标识无效')
  const values = await savedValues(filePath, env); const from = settingsFrom(values).from
  const renderedHtml = html ? renderRichEmailHtml(html) : renderMarkdownEmail(markdown)
  const plainText = html ? htmlToPlainText(html) : markdown
  const result = await createTransport(values).sendMail({ from, to, subject, ...(input.messageId ? { messageId: input.messageId } : {}), text: plainText, html: renderedHtml, ...(input.attachment ? { attachments: [{ filename: input.attachment.filename, content: input.attachment.content, contentType: 'application/pdf' }] } : {}) })
  if (!result.accepted?.length || result.rejected?.length) throw new Error('邮件服务器未受理指定收件人')
}
