import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createQuestionSheetGenerator, parseQuestionSheetResponse, QuestionSheetGenerationError } from './question-sheet-generator.js'

const config = { baseUrl: 'https://model.example.invalid/v1', apiKey: 'test-secret', model: 'test-model', timeoutMs: 120000 }
const input = { interviewTitle: '人事面试', jobTitle: '人事', requirements: [], skills: [], pairs: [{ question: '原始问题一', answerText: '实际回答' }, { question: '原始问题二', answerText: '' }] }
const item = (seq: number) => ({ seq, question: '模型改写不可覆盖', aiTier: 'pass', aiScore: 80, rationale: '说明', evidence: ['实际回答'] })

describe('面试表模型响应与错误', () => {
  it('按题号恢复顺序，保持原题原文；没有回答不接受模型的评分与依据', () => {
    const rows = parseQuestionSheetResponse({ questions: [item(2), item(1)] }, input.pairs)
    assert.deepEqual(rows.map(row => row.question), input.pairs.map(pair => pair.question))
    assert.equal(rows[0]!.aiScore, 80)
    assert.equal(rows[1]!.aiScore, null)
    assert.equal(rows[1]!.aiTier, null)
    assert.equal(rows[1]!.aiRationale, null)
    assert.deepEqual(rows[1]!.aiEvidence, [])
  })
  for (const evidence of [[], ['参考答案中的能力'], ['实际回答', '没有说过的经历']]) {
    it('局部参考分也必须引用对应实际发言：' + JSON.stringify(evidence), () => {
      const rows = parseQuestionSheetResponse({ questions: [{ ...item(1), evidence }] }, input.pairs.slice(0, 1))
      assert.equal(rows[0]!.aiScore, null)
      assert.equal(rows[0]!.aiTier, null)
      assert.deepEqual(rows[0]!.aiEvidence, [])
    })
  }
  it('null 分数不被 Number(null) 转为零分', () => {
    assert.equal(parseQuestionSheetResponse({ questions: [{ ...item(1), aiScore: null }] }, input.pairs.slice(0, 1))[0]!.aiScore, null)
  })
  for (const questions of [[item(1)], [null, item(2)], [item(1), item(1)], [item(1), { ...item(2), seq: undefined }]]) {
    it(`拒绝缺题、坏数据或重复题号：${JSON.stringify(questions.map(q => q?.seq))}`, () => {
      assert.throws(() => parseQuestionSheetResponse({ questions }, input.pairs), (error: unknown) => error instanceof QuestionSheetGenerationError && error.code === 'MODEL_RESPONSE_INVALID')
    })
  }
  it('请求超时显示真实超时时长，不泄露密钥或回答', async () => {
    const generator = createQuestionSheetGenerator(config, async () => { throw new DOMException('test-secret 实际回答', 'TimeoutError') })
    await assert.rejects(generator.generate(input), (error: unknown) => error instanceof QuestionSheetGenerationError && error.code === 'MODEL_REQUEST_FAILED' && /120 秒/.test(error.message) && !/test-secret|实际回答/.test(error.message))
  })
  it('响应体读取超时也归类为请求超时而不是 JSON 错误', async () => {
    const generator = createQuestionSheetGenerator(config, async () => ({ ok: true, json: async () => { throw new DOMException('timeout', 'TimeoutError') } }) as unknown as Response)
    await assert.rejects(generator.generate(input), (error: unknown) => error instanceof QuestionSheetGenerationError && error.code === 'MODEL_REQUEST_FAILED')
  })
  it('请求只包含本批问答并要求逐题返回，完整解析合法 JSON', async () => {
    const generator = createQuestionSheetGenerator(config, async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const user = JSON.parse(body.messages[1].content)
      assert.deepEqual(user.qa, input.pairs.map((pair, index) => ({ seq: index + 1, question: pair.question, answer: pair.answerText })))
      return Response.json({ choices: [{ message: { content: JSON.stringify({ questions: [item(1), item(2)] }) } }] })
    })
    assert.equal((await generator.generate(input)).length, 2)
  })
})
