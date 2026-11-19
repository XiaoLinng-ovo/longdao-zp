import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EXTRACTOR_VERSION, extractResume, parseResume } from '@smartrecruit-pro/resume-intelligence'
import { resumeExperienceView } from './resume-experience-view.js'
import { RecruitingService } from './service.js'
import type { NormalizedRecruitingRepository } from './repositories/postgres-repository.js'

const text = `项目经历
高考志愿推荐系统
项目描述
职员为项目负责人
领导团队设计并制作了推荐程序。
通过机器学习评估志愿的优先度。`
function fixture() {
  return {
    parsedResume: parseResume({ fileName: 'old.txt', text }),
    extraction: { extractorVersion: '0.4.0', candidate: { fullName: '测试候选人' }, profile: { totalExperienceYears: 3 }, experience: [
      { title: '项目描述', evidence: '项目描述' },
      { title: '领导团队设计并制作了推荐程序。', evidence: '领导团队设计并制作了推荐程序。' },
      { title: '通过机器学习评估志愿的优先度。', evidence: '通过机器学习评估志愿的优先度。' },
    ] },
    assessment: { score: 82 },
    humanReview: { status: 'accepted', comment: '人工评价', history: [{ score: 85 }] },
    provenance: { extractorVersion: '0.4.0' },
  }
}

describe('saved resume experience view', () => {
  it('filters saved PDF skill and language noise without rescoring or mutating history', () => {
    const watermark = '56ac1a7c4269df3f1HFy3N25FlNTxo66UPOcWOejn_TYPxJi'
    const original = {
      analysis: { report: {
        parsedResume: { originalText: `技能\n${watermark}\ni\n-- 1 of 2 --\nPython、R\n语言能力\n英语：精通\n${watermark}\ni\n-- 2 of 2 --` },
        extraction: { extractorVersion: '0.5.0', candidate: { fullName: '测试候选人' },
          skills: [{ value: watermark }, { value: 'i' }, { value: '-- 1 of 2 --' }, { value: 'Python' }, { value: 'R' }],
          languages: ['英语：精通', watermark, 'i', '-- 2 of 2 --'], certifications: ['CET-6 580 分'],
        }, assessment: { score: 54 }, humanReview: { status: 'accepted' }, provenance: { extractorVersion: '0.5.0' },
      } }, scoring: { aiScore: 54, humanScore: 58 }, humanDecision: { status: 'passed' },
    }
    const before = JSON.stringify(original)
    const cleaned = resumeExperienceView(original) as typeof original
    assert.deepEqual(cleaned.analysis.report.extraction.skills, [{ value: 'Python' }, { value: 'R' }])
    assert.deepEqual(cleaned.analysis.report.extraction.languages, ['英语：精通'])
    assert.equal(cleaned.analysis.report.assessment, original.analysis.report.assessment)
    assert.equal(cleaned.analysis.report.humanReview, original.analysis.report.humanReview)
    assert.equal(cleaned.analysis.report.provenance, original.analysis.report.provenance)
    assert.equal(cleaned.scoring, original.scoring)
    assert.equal(cleaned.humanDecision, original.humanDecision)
    assert.equal(cleaned.analysis.report.parsedResume, original.analysis.report.parsedResume)
    assert.equal(JSON.stringify(original), before)
    assert.equal(resumeExperienceView(cleaned), cleaned)
  })
  it('groups historical top-level reports without mutating stored extraction, scoring or reviews', () => {
    const original = fixture()
    const before = JSON.stringify(original)
    const repaired = resumeExperienceView(original) as ReturnType<typeof fixture>
    assert.equal(repaired.extraction.experience.length, 1)
    assert.equal(repaired.extraction.experience[0]!.title, '高考志愿推荐系统')
    assert.match((repaired.extraction.experience[0] as unknown as { description: string }).description, /机器学习/u)
    assert.equal(repaired.assessment, original.assessment)
    assert.equal(repaired.humanReview, original.humanReview)
    assert.equal(repaired.provenance, original.provenance)
    assert.equal(repaired.extraction.profile, original.extraction.profile)
    assert.equal(repaired.extraction.candidate, original.extraction.candidate)
    assert.equal(JSON.stringify(original), before)
  })
  it('supports nested worker reports and retains root-level human decisions and scores', () => {
    const original = { analysis: { engine: 'llm-suggestion', report: fixture() }, scoring: { aiScore: 82, finalScore: 85 }, humanDecision: { status: 'passed' } }
    const repaired = resumeExperienceView(original) as typeof original
    assert.equal(repaired.analysis.report.extraction.experience.length, 1)
    assert.equal(repaired.analysis.engine, original.analysis.engine)
    assert.equal(repaired.scoring, original.scoring)
    assert.equal(repaired.humanDecision, original.humanDecision)
    assert.equal(original.analysis.report.extraction.experience.length, 3)
  })
  it('leaves current-version reports unchanged and is idempotent for repaired historical views', () => {
    const current = { ...fixture(), extraction: extractResume(parseResume({ fileName: 'new.txt', text })) }
    assert.equal(current.extraction.extractorVersion, EXTRACTOR_VERSION)
    assert.equal(resumeExperienceView(current), current)
    const once = resumeExperienceView(fixture())
    assert.deepEqual(resumeExperienceView(once), once)
  })
  it('uses the saved normalized text if original text is unavailable', () => {
    const original = { ...fixture(), parsedResume: { normalizedText: text } }
    const repaired = resumeExperienceView(original) as typeof original
    assert.equal(repaired.extraction.experience.length, 1)
  })
  it('does not guess or combine historical rows when saved source text is missing', () => {
    for (const value of [null, [], 'bad', {}, { extraction: fixture().extraction }, { ...fixture(), parsedResume: { originalText: '' } }, { ...fixture(), parsedResume: { originalText: '技能\nJava' } }]) {
      assert.equal(resumeExperienceView(value), value)
    }
  })
  it('does not replace extractions from a future version or another extraction engine', () => {
    for (const version of ['0.6.0', 'llm-v1', undefined]) {
      const original = { ...fixture(), extraction: { ...fixture().extraction, extractorVersion: version } }
      assert.equal(resumeExperienceView(original), original)
    }
  })
  it('returns repaired candidate details through the repository path without writing history', async () => {
    const stored = fixture()
    const before = JSON.stringify(stored)
    const repository = {
      getCandidate: async () => ({ id: 'candidate-1', businessId: 'CAN-1', name: '测试候选人', consentStatus: 'active' }),
      listApplications: async () => [],
      listResumes: async () => [{ id: 'resume-1', candidateId: 'candidate-1' }],
      listAnalysisTasks: async () => [],
      listAnalysisResults: async () => [{ id: 'result-1', resumeId: 'resume-1', result: { analysis: { report: stored } } }],
      listJobs: async () => [],
    } as unknown as NormalizedRecruitingRepository
    const service = new RecruitingService(undefined, undefined, undefined, repository)
    const detail = await service.getCandidate('candidate-1')
    const result = detail.analysisResults[0]!.result as { analysis: { report: ReturnType<typeof fixture> } }
    assert.equal(result.analysis.report.extraction.experience.length, 1)
    assert.equal(result.analysis.report.extraction.experience[0]!.title, '高考志愿推荐系统')
    assert.equal(JSON.stringify(stored), before)
  })
})
