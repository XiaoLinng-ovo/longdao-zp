import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TranscriptContextCorrector } from './transcript-context-corrector.js'
import type { CorrectedTranscriptTurn } from './transcript-postprocessing.js'

const turn = (id: string, text: string): CorrectedTranscriptTurn => ({ id, speakerId: 'voice-1', role: 'candidate',
  confidence: .9, text, startMs: 0, endMs: 1000, evidenceIds: [`live:${id}`], roleReasons: [] })

describe('contextual transcript correction guardrails', () => {
  it('keeps original text when the model changes numbers, negation or a protected name', async () => {
    const input = [turn('number', '我负责3个项目，没有延期。'), turn('name', '我在腾讯公司负责招聘平台。'), turn('term', '我调用拉一个接口。')]
    const content = { corrections: [
      { turnId: 'number', text: '我负责5个项目，没有延期。', reason: '修正数量' },
      { turnId: 'name', text: '我在腾迅公司负责招聘平台。', reason: '修正错字' },
      { turnId: 'term', text: '我调用了一个接口。', reason: '修正同音字' },
    ], uncertainties: [] }
    const corrector = new TranscriptContextCorrector(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }), { headers: { 'content-type': 'application/json' } }))

    const result = await corrector.correct({ turns: input, context: { candidateName: '张三', jobTitle: '后端工程师',
      requirements: ['熟悉接口开发'], skills: ['TypeScript'] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(result.turns[0]!.text, input[0]!.text)
    assert.equal(result.turns[1]!.text, input[1]!.text)
    assert.equal(result.turns[2]!.text, '我调用了一个接口。')
    assert.equal(result.corrections.length, 1)
    assert.equal(result.uncertainties.length, 2)
  })

  it('returns only changed turns and automatically preserves all omitted turns', async () => {
    const input = [turn('one', '第一轮保持原文。'), turn('two', '我调用拉一个接口。'), turn('three', '第三轮也保持原文。')]
    const content = { corrections: [{ turnId: 'two', text: '我调用了一个接口。', reason: '修正同音字' }], uncertainties: [] }
    const corrector = new TranscriptContextCorrector(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }), { headers: { 'content-type': 'application/json' } }))

    const result = await corrector.correct({ turns: input, context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.deepEqual(result.turns.map(item => item.text), ['第一轮保持原文。', '我调用了一个接口。', '第三轮也保持原文。'])
    assert.equal(result.corrections.length, 1)
    assert.deepEqual(result.warnings, [])
  })

  it('falls back to the delimited plain-text protocol when JSON output fails', async () => {
    const input = [turn('one', '我调用拉一个接口。'), turn('two', '第二轮保持原文。')]
    const content = '<<<TURN one>>>\n我调用了一个接口。\n<<<END>>>'
    const requestBodies: Array<Record<string, unknown>> = []
    const corrector = new TranscriptContextCorrector(async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({
        choices: [{ message: { content: requestBodies.length === 1 ? 'not-json' : content } }],
      }), { headers: { 'content-type': 'application/json' } })
    })

    const result = await corrector.correct({ turns: input, context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(result.turns[0]!.text, '我调用了一个接口。')
    assert.equal(result.turns[1]!.text, '第二轮保持原文。')
    assert.equal(result.corrections.length, 1)
    assert.deepEqual(result.warnings, [])
    assert.equal(requestBodies.length, 2)
    assert.deepEqual(requestBodies[0]?.response_format, { type: 'json_object' })
    assert.equal(requestBodies[1]?.response_format, undefined)
    const messages = requestBodies[1]?.messages as Array<{ content: string }>
    assert.match(messages[0]!.content, /<<<TURN turnId>>>/u)
  })

  it('uses the short JSON protocol by default and accepts a safe NO_CHANGES answer', async () => {
    let requestBody: Record<string, unknown> | undefined
    const corrector = new TranscriptContextCorrector(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
      choices: [{ message: { content: 'NO_CHANGES' } }],
      }), { headers: { 'content-type': 'application/json' } })
    })

    const result = await corrector.correct({ turns: [turn('one', '这一轮无需修改。')],
      context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'deepseek-v4-flash', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.deepEqual(result.corrections, [])
    assert.deepEqual(result.uncertainties, [])
    assert.deepEqual(result.warnings, [])
    assert.equal(requestBody?.max_completion_tokens, 4096)
    assert.equal(requestBody?.max_tokens, undefined)
    assert.deepEqual(requestBody?.thinking, { type: 'disabled' })
    assert.deepEqual(requestBody?.response_format, { type: 'json_object' })
    const messages = requestBody?.messages as Array<{ content: string }>
    assert.match(messages[0]!.content, /只返回一个短 JSON 对象/u)
  })

  it('recovers a final NO_CHANGES marker from provider reasoning when content is empty', async () => {
    const corrector = new TranscriptContextCorrector(async () => new Response(JSON.stringify({
      choices: [{ message: { content: null, reasoning_content: '逐轮检查完成，没有明确错误。\nNO_CHANGES' } }],
    }), { headers: { 'content-type': 'application/json' } }))

    const result = await corrector.correct({ turns: [turn('one', '这一轮无需修改。')],
      context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.deepEqual(result.corrections, [])
    assert.deepEqual(result.uncertainties, [])
    assert.deepEqual(result.warnings, [])
  })

  it('recovers an explicit terminal no-change conclusion from reasoning when content is empty', async () => {
    let calls = 0
    const corrector = new TranscriptContextCorrector(async () => {
      calls++
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, reasoning_content: 'All terms checked. No changes needed.' } }],
      }), { headers: { 'content-type': 'application/json' } })
    })

    const result = await corrector.correct({ turns: [turn('one', '这一轮无需修改。')],
      context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(calls, 1)
    assert.deepEqual(result.corrections, [])
    assert.deepEqual(result.uncertainties, [])
  })

  it('recovers a truncated no-change marker only when reasoning confirms no changes', async () => {
    let calls = 0
    const corrector = new TranscriptContextCorrector(async () => {
      calls++
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'NO', reasoning_content: '逐轮检查完成，无需修改。' } }],
      }), { headers: { 'content-type': 'application/json' } })
    })

    const result = await corrector.correct({ turns: [turn('one', '我负责接口开发。')],
      context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(calls, 1)
    assert.deepEqual(result.corrections, [])
    assert.deepEqual(result.uncertainties, [])
  })

  it('keeps an ambiguous truncated marker uncertain', async () => {
    let calls = 0
    const corrector = new TranscriptContextCorrector(async () => {
      calls++
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'NO_CH', reasoning_content: '公司名称仍需进一步判断。' } }],
      }), { headers: { 'content-type': 'application/json' } })
    })

    const result = await corrector.correct({ turns: [turn('one', '我在克莱斯科技工作。')],
      context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(calls, 2)
    assert.deepEqual(result.corrections, [])
    assert.equal(result.uncertainties.length, 1)
    assert.equal(result.uncertainties[0]!.turnId, 'one')
  })

  it('marks a turn uncertain when the provider returns analysis without a result', async () => {
    let calls = 0
    const corrector = new TranscriptContextCorrector(async () => {
      calls++
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, reasoning_content: '仍在分析候选人的公司名称。' } }],
      }), { headers: { 'content-type': 'application/json' } })
    })

    const result = await corrector.correct({ turns: [turn('one', '我在克莱斯科技工作。')],
      context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.deepEqual(result.warnings, [])
    assert.deepEqual(result.uncertainties, [{ turnId: 'one', original: '我在克莱斯科技工作。',
      reason: '模型只返回了分析过程，没有返回校对结果，已保留原文。' }])
    assert.equal(calls, 2)
  })

  it('splits a multi-turn batch when the provider returns analysis without a result', async () => {
    const input = [turn('one', '第一轮保持原文。'), turn('two', '第二轮保持原文。'),
      turn('three', '第三轮保持原文。'), turn('four', '第四轮保持原文。')]
    let calls = 0
    const corrector = new TranscriptContextCorrector(async () => {
      calls++
      const message = calls <= 2
        ? { content: null, reasoning_content: '正在逐轮分析。' }
        : { content: 'NO_CHANGES' }
      return new Response(JSON.stringify({ choices: [{ message }] }),
        { headers: { 'content-type': 'application/json' } })
    })

    const result = await corrector.correct({ turns: input,
      context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(calls, 4)
    assert.deepEqual(result.turns.map(item => item.text), input.map(item => item.text))
    assert.deepEqual(result.corrections, [])
    assert.deepEqual(result.uncertainties, [])
    assert.deepEqual(result.warnings, [])
  })

  it('accepts an empty corrections array for unchanged long text', async () => {
    const original = '这是一段较长的候选人回答，用来确认模型在没有发现同音字、断句或明确术语问题时不需要返回整段原文。'
    const content = { corrections: [], uncertainties: [] }
    const corrector = new TranscriptContextCorrector(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }), { headers: { 'content-type': 'application/json' } }))

    const result = await corrector.correct({ turns: [turn('long', original)], context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(result.turns[0]!.text, original)
    assert.deepEqual(result.corrections, [])
    assert.deepEqual(result.warnings, [])
  })

  it('publishes deterministic text with a warning when enterprise AI is not configured', async () => {
    const corrector = new TranscriptContextCorrector(async () => { throw new Error('must not call model') })
    const input = [turn('one', '我負責這個項目。')]
    const result = await corrector.correct({ turns: input,
      context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {})

    assert.equal(result.turns[0]!.text, '我负责这个项目。')
    assert.equal(result.corrections.length, 0)
    assert.match(result.warnings[0]!, /模型未配置/u)
  })

  it('accepts JSON wrapped in a markdown code fence', async () => {
    const input = [turn('fenced', '我调用拉一个接口。')]
    const content = { corrections: [{ turnId: 'fenced', text: '我调用了一个接口。', reason: '修正同音字' }], uncertainties: [] }
    const corrector = new TranscriptContextCorrector(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '```json\n' + JSON.stringify(content) + '\n```' } }],
    }), { headers: { 'content-type': 'application/json' } }))

    const result = await corrector.correct({ turns: input, context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(result.turns[0]!.text, '我调用了一个接口。')
    assert.equal(result.corrections.length, 1)
    assert.deepEqual(result.warnings, [])
  })

  it('recovers only a complete JSON payload missing its final closing brace', async () => {
    const input = [turn('one', '我调用拉一个接口。')]
    const content = '{"corrections":[{"turnId":"one","text":"我调用了一个接口。","reason":"修正同音字"}],"uncertainties":[]'
    const corrector = new TranscriptContextCorrector(async () => new Response(JSON.stringify({
      choices: [{ message: { content } }],
    }), { headers: { 'content-type': 'application/json' } }))

    const result = await corrector.correct({ turns: input, context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(result.turns[0]!.text, '我调用了一个接口。')
    assert.equal(result.corrections.length, 1)
    assert.deepEqual(result.warnings, [])
  })

  it('retries a transient connection failure before accepting the correction', async () => {
    const input = [turn('one', '我调用拉一个接口。')]
    let calls = 0
    const corrector = new TranscriptContextCorrector(async () => {
      calls++
      if (calls === 1) throw new TypeError('fetch failed')
      const content = { corrections: [{ turnId: 'one', text: '我调用了一个接口。', reason: '修正同音字' }], uncertainties: [] }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
        { headers: { 'content-type': 'application/json' } })
    })

    const result = await corrector.correct({ turns: input, context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(calls, 2)
    assert.equal(result.turns[0]!.text, '我调用了一个接口。')
    assert.deepEqual(result.warnings, [])
  })

  it('rejects a correction array cut off midway instead of accepting a partial result', async () => {
    const input = [turn('one', '第一轮。'), turn('two', '第二轮。')]
    let calls = 0
    const corrector = new TranscriptContextCorrector(async () => {
      calls++
      const content = calls === 1
        ? '{"corrections":[{"turnId":"one","text":"第'
        : '{"corrections":[],"uncertainties":[]}'
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }),
        { headers: { 'content-type': 'application/json' } })
    })

    const result = await corrector.correct({ turns: input, context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(calls, 4)
    assert.deepEqual(result.turns.map(item => item.text), input.map(item => item.text))
    assert.deepEqual(result.warnings, [])
  })

  it('splits a failed model batch and retries smaller requests', async () => {
    const input = [turn('one', '我负责接口开发。'), turn('two', '我参与项目上线。')]
    let calls = 0
    const corrector = new TranscriptContextCorrector(async (_url, init) => {
      calls++
      if (calls === 1) return new Response(JSON.stringify({ choices: [{ message: { content: 'not-json' } }] }),
        { headers: { 'content-type': 'application/json' } })
      const payload = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
      const requested = JSON.parse(payload.messages[1]!.content) as { turnsToCorrect: Array<{ turnId: string; text: string }> }
      const content = { corrections: [], uncertainties: [] }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
        { headers: { 'content-type': 'application/json' } })
    })

    const result = await corrector.correct({ turns: input, context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(calls, 4)
    assert.deepEqual(result.turns.map(item => item.text), input.map(item => item.text))
    assert.deepEqual(result.warnings, [])
  })

  it('caps repeated format failures and marks each turn uncertain', async () => {
    const input = [turn('one', '第一轮。'), turn('two', '第二轮。'), turn('three', '第三轮。'), turn('four', '第四轮。')]
    let calls = 0
    const corrector = new TranscriptContextCorrector(async () => {
      calls++
      return new Response(JSON.stringify({ choices: [{ message: { content: 'not-json' } }] }),
        { headers: { 'content-type': 'application/json' } })
    })

    const result = await corrector.correct({ turns: input,
      context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(calls, 6)
    assert.deepEqual(result.corrections, [])
    assert.deepEqual(result.uncertainties.map(item => item.turnId), ['one', 'two', 'three', 'four'])
    assert.deepEqual(result.warnings, [])
  })

  it('keeps compatibility with the previous all-turns response format', async () => {
    const input = [turn('one', '我调用拉一个接口。'), turn('two', '我负责项目上线。')]
    const content = { turns: [
      { turnId: 'one', text: '我调用了一个接口。', reason: '修正同音字' },
      { turnId: 'two', text: '我负责项目上线。', reason: '保持原文' },
    ], uncertainties: [] }
    const corrector = new TranscriptContextCorrector(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }), { headers: { 'content-type': 'application/json' } }))

    const result = await corrector.correct({ turns: input, context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(result.turns[0]!.text, '我调用了一个接口。')
    assert.equal(result.turns[1]!.text, '我负责项目上线。')
    assert.equal(result.corrections.length, 1)
    assert.deepEqual(result.warnings, [])
  })

  it('shows a Chinese warning when model correction times out', async () => {
    const corrector = new TranscriptContextCorrector(async () => {
      throw new Error('The operation was aborted due to timeout')
    })
    const result = await corrector.correct({ turns: [turn('one', '我负责接口开发。')],
      context: { candidateName: '', jobTitle: '', requirements: [], skills: [] } }, {
      OPENAI_BASE_URL: 'https://model.invalid/v1', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model', OPENAI_TIMEOUT_MS: '1000',
    })

    assert.equal(result.turns[0]!.text, '我负责接口开发。')
    assert.match(result.warnings[0]!, /模型校对请求超时/u)
    assert.doesNotMatch(result.warnings[0]!, /aborted/iu)
    assert.deepEqual(result.uncertainties, [{ turnId: 'one', original: '我负责接口开发。',
      reason: '模型校对请求超时，这一轮未完成上下文校对，已保留原文。' }])
  })
})
