import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { decodePdfAttachment, renderMarkdownEmail, renderRichEmailHtml, sanitizeRichEmailHtml, updateSmtpEnvSettings } from './smtp.js'

const original = Object.fromEntries(['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'].map((key) => [key, process.env[key]]))
const temporaryPaths: string[] = []

afterEach(async () => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('SMTP 邮件集成', () => {
  it('preserves reference underlines through repeated preview and SMTP rendering without trusting span styles', () => {
    const source = '<p>薪资：<strong><span data-offer-variable="baseSalary" data-offer-original="8000" onclick="alert(1)" style="color:red">8000</span></strong></p><p><span data-offer-variable="materials">1. 身份证；<br>2. 工资卡；</span></p><p><span style="text-decoration:underline">普通正文</span></p>'
    const sanitized = sanitizeRichEmailHtml(source)
    assert.match(sanitized, /<strong[^>]*><u style="text-decoration:underline;?">8000<\/u><\/strong>/u)
    assert.match(sanitized, /<u style="text-decoration:underline;?">1\. 身份证；<br \/>2\. 工资卡；<\/u>/u)
    assert.doesNotMatch(sanitized, /data-offer-variable|data-offer-original|onclick|color:red|<span/u)
    assert.doesNotMatch(sanitized, /<u[^>]*>普通正文/u)
    assert.equal(renderRichEmailHtml(sanitized), renderRichEmailHtml(source))
  })
  it('escapes raw HTML while rendering the supported Markdown subset', () => {
    const rendered = renderMarkdownEmail('# 标题\n\n- **重点**\n- [链接](https://example.com)\n\n1. 第一项\n2. 第二项\n\n<script>alert(1)</script>')
    assert.match(rendered, /max-width:760px/u)
    assert.match(rendered, /font-size:17px/u)
    assert.match(rendered, /<h1 style="[^"]*text-align:center[^"]*font-size:32px[^"]*">标题<\/h1>/u)
    assert.match(rendered, /<strong style="[^"]*font-weight:700[^"]*">重点<\/strong>/u)
    assert.match(rendered, /<a href="https:\/\/example\.com" style="[^"]*">链接<\/a>/u)
    assert.match(rendered, /<ol style="[^"]*"><li style="[^"]*">第一项<\/li><li style="[^"]*">第二项<\/li><\/ol>/u)
    assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u)
  })

  it('renders a plain Offer title and Chinese section headings with readable hierarchy', () => {
    const rendered = renderMarkdownEmail('录用通知书：\n\n非常荣幸地通知您。\n\n一、办理入职手续需提供的材料\n\n1. 毕业证书、学位证书；')
    assert.match(rendered, /<h1 style="[^"]*text-align:center[^"]*font-size:32px[^"]*">录用通知书：<\/h1>/u)
    assert.match(rendered, /<p style="[^"]*text-indent:2em[^"]*">非常荣幸地通知您。<\/p>/u)
    assert.match(rendered, /<h2 style="[^"]*font-size:19px[^"]*">一、办理入职手续需提供的材料<\/h2>/u)
  })

  it('sanitizes rich HTML and keeps a consistent email layout', () => {
    const sanitized = sanitizeRichEmailHtml('<h1 onclick="alert(1)" style="font-size:9px">录用通知书</h1><p>第一段<script>alert(1)</script></p><p><strong>重点</strong><br>下一行</p><a href="javascript:alert(1)">危险链接</a>')
    assert.match(sanitized, /<h1 style="[^"]*text-align:center[^"]*font-size:32px[^"]*">录用通知书<\/h1>/u)
    assert.match(sanitized, /<p style="[^"]*text-indent:2em[^"]*">第一段<\/p>/u)
    assert.doesNotMatch(sanitized, /script|onclick|javascript|font-size:9px/iu)
    assert.match(sanitized, /<a[^>]*>危险链接<\/a>/u)

    const rendered = renderRichEmailHtml(sanitized)
    assert.match(rendered, /<div style="[^"]*max-width:760px[^"]*">/u)
    assert.match(rendered, /font-size:17px/u)
  })

  it('does not indent the candidate greeting or onboarding-material reference', () => {
    const sanitized = sanitizeRichEmailHtml([
      '<p data-offer-role="candidate-greeting">张明，您好：</p>',
      '<p>录用正文介绍。</p>',
      '<p data-offer-role="onboarding-materials">1. 身份证；<br>2. 工资卡；</p>',
    ].join(''))
    assert.match(sanitized, /<p data-offer-role="candidate-greeting" style="margin:0 0 16px;text-indent:0">张明，您好：<\/p>/u)
    assert.match(sanitized, /<p style="margin:0 0 16px;text-indent:2em">录用正文介绍。<\/p>/u)
    assert.match(sanitized, /<p data-offer-role="onboarding-materials" style="margin:0 0 16px;text-indent:0">1\. 身份证；<br \/>2\. 工资卡；<\/p>/u)
  })

  it('accepts only a PDF base64 attachment within the size limit', () => {
    const content = Buffer.from('%PDF-1.7\nbody', 'utf8').toString('base64')
    const attachment = decodePdfAttachment({ filename: 'offer.pdf', mimeType: 'application/pdf', content })
    assert.equal(attachment?.filename, 'offer.pdf')
    assert.deepEqual(attachment?.content, Buffer.from('%PDF-1.7\nbody', 'utf8'))
    assert.throws(() => decodePdfAttachment({ filename: 'offer.txt', mimeType: 'text/plain', content }), /PDF/u)
  })

  it('writes SMTP settings without returning the password in the settings view', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-smtp-'))
    temporaryPaths.push(directory)
    const filePath = join(directory, '.env')
    const settings = await updateSmtpEnvSettings(filePath, {
      SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_SECURE: 'true',
      SMTP_USER: 'sender@example.com', SMTP_PASSWORD: 'app-password', SMTP_FROM: '招聘团队 <sender@example.com>',
    })
    assert.equal(settings.SMTP_PASSWORD.value, 'ap••••rd')
    assert.equal(settings.SMTP_PASSWORD.configured, true)
    const persisted = await readFile(filePath, 'utf8')
    assert.match(persisted, /SMTP_HOST=smtp\.example\.com/u)
    assert.match(persisted, /SMTP_PASSWORD=app-password/u)
  })

  it('preserves the saved password when updating non-secret settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-smtp-preserve-'))
    temporaryPaths.push(directory)
    const filePath = join(directory, '.env')
    await updateSmtpEnvSettings(filePath, {
      SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_SECURE: 'true',
      SMTP_USER: 'sender@example.com', SMTP_PASSWORD: 'app-password', SMTP_FROM: '招聘团队 <sender@example.com>',
    })
    const settings = await updateSmtpEnvSettings(filePath, { SMTP_FROM: '人力资源 <sender@example.com>' })
    assert.equal(settings.SMTP_PASSWORD.configured, true)
    const persisted = await readFile(filePath, 'utf8')
    assert.match(persisted, /SMTP_PASSWORD=app-password/u)
    assert.match(persisted, /SMTP_FROM=人力资源 <sender@example\.com>/u)
  })
  it('reports settings supplied directly by the process environment', async () => {
    process.env.SMTP_HOST = 'smtp.example.com'
    process.env.SMTP_PORT = '587'
    process.env.SMTP_SECURE = 'false'
    process.env.SMTP_USER = 'sender@example.com'
    process.env.SMTP_PASSWORD = 'environment-password'
    process.env.SMTP_FROM = '招聘团队 <sender@example.com>'
    const directory = await mkdtemp(join(tmpdir(), 'smartrecruit-smtp-env-'))
    temporaryPaths.push(directory)
    const { readSmtpEnvSettings } = await import('./smtp.js')
    const settings = await readSmtpEnvSettings(join(directory, '.env'))
    assert.equal(settings.SMTP_HOST.value, 'smtp.example.com')
    assert.equal(settings.SMTP_PASSWORD.configured, true)
    assert.equal(settings.SMTP_PASSWORD.value, 'en••••rd')
  })
})
