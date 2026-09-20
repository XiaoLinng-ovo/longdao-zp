import test from 'node:test'
import assert from 'node:assert/strict'
import { anonymizeText, buildJobRequirements, buildResumeAnalysisPrompt, buildRuleBasedReport, extractResume, inferRequirementKind, minYearsFromLabel, parseLlmResumeSuggestion, parseResume, scoreResumeMatch } from '../src/index.js'

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

test('classifies Chinese resume section headings and extracts content', () => {
  const parsed = parseResume({ fileName: 'resume.txt', mimeType: 'text/plain', text: resume, source: 'test' })
  const kinds = parsed.sections.map((section) => section.kind)
  assert.ok(kinds.includes('experience'), '工作经历 should map to experience')
  assert.ok(kinds.includes('education'), '教育经历 should map to education')
  assert.ok(kinds.includes('skills'), '技能 should map to skills')
  const extraction = extractResume(parsed)
  assert.ok(extraction.experience.length > 0)
  assert.ok(extraction.education.length > 0)
  assert.ok(extraction.skills.length > 0)
  assert.equal(extraction.skills.some((skill) => skill.canonical === 'typescript'), true)
})

test('validates the structured LLM suggestion contract', () => {
  const suggestion = parseLlmResumeSuggestion({
    summary: '建议人工复核', score: 82, strengths: ['TypeScript'], risks: [],
    matchedRequirements: [], conflicts: [], interviewQuestions: ['请介绍项目'], confidence: 0.8,
  })
  assert.equal(suggestion.score, 82)
  assert.equal(suggestion.confidence, 0.8)
  assert.throws(() => parseLlmResumeSuggestion({ summary: 42 }), /summary/u)
  assert.throws(() => parseLlmResumeSuggestion({
    summary: 'x', score: 80, strengths: [], risks: [], matchedRequirements: [], conflicts: [], interviewQuestions: [], confidence: 2,
  }), /confidence/u)
})

test('infers requirement kinds so each scoring dimension can be evaluated', () => {
  assert.equal(inferRequirementKind('5 年以上后端开发经验'), 'experience')
  assert.equal(inferRequirementKind('本科及以上学历，计算机相关专业'), 'education')
  assert.equal(inferRequirementKind('熟悉 Java、Spring Boot'), 'skill')
  assert.equal(inferRequirementKind('有良好的沟通能力'), 'other')
  assert.equal(minYearsFromLabel('5 年以上后端开发经验'), 5)
  assert.equal(minYearsFromLabel('经验不限'), undefined)

  const requirements = buildJobRequirements({
    jobId: 'job-1',
    requirementLabels: ['5 年以上后端开发经验', '本科及以上学历', '熟悉 Java、Spring Boot', '熟悉数据库与分布式系统基础：能够处理性能、并发和稳定性问题'],
    skills: ['Java/Spring Boot', 'PostgreSQL'],
  })
  assert.deepEqual(requirements.map((item) => item.kind), ['skill', 'skill', 'experience', 'education', 'skill', 'other'])
  assert.deepEqual(requirements.map((item) => item.hard), [false, false, true, false, false, false])
  assert.equal(requirements[2]?.minYears, 5)
  assert.deepEqual(requirements[0]?.keywords, ['Java', 'Spring Boot'])
  assert.deepEqual(requirements[4]?.keywords, ['Java', 'Spring Boot'])
  assert.deepEqual(requirements[5]?.keywords, ['熟悉数据库与分布式系统基础：能够处理性能、并发和稳定性问题'])
})

test('scores only the dimensions the job actually asks for', () => {
  const parsed = parseResume({ fileName: 'resume.txt', mimeType: 'text/plain', text: resume, source: 'test' })
  const extraction = extractResume(parsed)

  const partial = scoreResumeMatch({ extraction, job: { title: '后端工程师', requirements: [job.requirements[0]!] } })
  assert.equal(typeof partial.dimensions.skills, 'number')
  assert.equal(partial.dimensions.experience, null)
  assert.equal(partial.dimensions.education, null)

  // 岗位没有任何要求时不能伪造出 0 分维度，也不能给出匹配结论。
  const emptyJob = scoreResumeMatch({ extraction, job: { title: '后端工程师', requirements: [] } })
  assert.equal(emptyJob.dimensions.hardRequirement, null)
  assert.equal(emptyJob.dimensions.experience, null)
  assert.equal(emptyJob.dimensions.skills, null)
  assert.equal(emptyJob.dimensions.education, null)
  assert.equal(typeof emptyJob.dimensions.potential, 'number')
  assert.equal(emptyJob.recommendation, 'needs_review')
  assert.match(emptyJob.risks[0] ?? '', /岗位未提供任职要求/u)
})

test('counts every job requirement, including ones outside the four dimensions', () => {
  const parsed = parseResume({ fileName: 'resume.txt', mimeType: 'text/plain', text: resume, source: 'test' })
  const extraction = extractResume(parsed)
  const scored = scoreResumeMatch({
    extraction,
    job: {
      title: '后端工程师',
      requirements: [
        { id: 'r1', label: '熟悉 TypeScript、Node.js', kind: 'skill', keywords: ['typescript', 'node.js'], hard: false },
        // 无法在简历中找到证据的通用要求，必须同样把总分拉下来，否则会出现「一半要求没证据却是强匹配」。
        { id: 'r2', label: '具备良好的跨部门沟通与协调能力', kind: 'other', keywords: ['具备良好的跨部门沟通与协调能力'], hard: false },
      ],
    },
  })
  assert.equal(scored.dimensions.skills, 100)
  assert.ok(scored.score <= 60, `expected a review-worthy score, received ${scored.score}`)
  assert.notEqual(scored.recommendation, 'strong_match')
  assert.equal(scored.missingRequirements.length, 1)
})
