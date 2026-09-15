import test from 'node:test'
import assert from 'node:assert/strict'
import { anonymizeText, buildResumeAnalysisPrompt, buildRuleBasedReport, parseResume } from '../src/index.js'

const resume = `张三
zhangsan@example.com
138-1234-5678

工作经历
2021-2024 后端工程师
使用 TypeScript、Node.js 和 PostgreSQL

技能
TypeScript, Node.js, PostgreSQL

教育经历
本科 计算机科学`

const job = {
  title: '后端工程师',
  requirements: [
    { id: 'skill-ts', label: 'TypeScript', kind: 'skill' as const, keywords: ['typescript'], hard: true },
    { id: 'skill-pg', label: 'PostgreSQL', kind: 'skill' as const, keywords: ['postgresql'] },
    { id: 'exp', label: '3 年经验', kind: 'experience' as const, minYears: 3, hard: true },
  ],
}

test('parses and anonymizes resume text', () => {
  const parsed = parseResume({ fileName: 'resume.txt', mimeType: 'text/plain', text: resume, source: 'test' })
  assert.equal(parsed.format, 'txt')
  assert.ok(parsed.sections.length > 0)
  const anonymized = anonymizeText(parsed.normalizedText, { name: '张三', replaceNames: true })
  assert.equal(anonymized.text.includes('zhangsan@example.com'), false)
  assert.equal(anonymized.text.includes('[EMAIL]'), true)
  assert.equal(anonymized.text.includes('[NAME]'), true)
})

test('builds an advisory report without changing application state', () => {
  const report = buildRuleBasedReport({
    resume: { fileName: 'resume.txt', mimeType: 'text/plain', text: resume, source: 'test' },
    job,
    subject: { applicationId: 'app-1', candidateId: 'candidate-1', jobId: 'job-1' },
  })
  assert.ok(report.assessment.score > 0)
  assert.equal(report.safety.advisoryOnly, true)
  assert.equal(report.safety.applicationStatusMutation, 'none')
  assert.equal(report.safety.autoReject, false)
  assert.equal(report.humanReview.status, 'pending')
})

test('builds a privacy-aware LLM prompt', () => {
  const prompt = buildResumeAnalysisPrompt({ anonymizedResumeText: '[NAME] [EMAIL]', job })
  assert.equal(prompt.includes('不得自动淘汰'), true)
  assert.equal(prompt.includes('[EMAIL]'), true)
})
