import assert from 'node:assert/strict'
import test from 'node:test'
import { startLocalModelBoundary, syntheticResumeEvidence, syntheticAnswer } from './local-model-boundary.mjs'

test('本机模型只接受合成鉴权、岗位与原文证据，返回真实要求ID', async () => {
  const model = await startLocalModelBoundary({ apiKey: 'synthetic-key' })
  try {
    const body = {
      model: 'isolated-synthetic-model',
      messages: [{ role: 'user', content: '岗位信息：' + JSON.stringify({ title: '合成软件工程师', requirements: [{ id: 'real-worker-requirement', label: '软件开发：具备软件研发经验' }] }) + '\n\n脱敏简历：\n' + syntheticResumeEvidence }],
    }
    const send = (value, key = 'synthetic-key') => fetch('http://127.0.0.1:' + model.port + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(value),
    })
    const response = await send(body)
    assert.equal(response.status, 200)
    const suggestion = JSON.parse((await response.json()).choices[0].message.content)
    assert.equal(suggestion.requirementAssessments[0].requirementId, 'real-worker-requirement')
    assert.deepEqual(suggestion.requirementAssessments[0].sourceTexts, [syntheticResumeEvidence])
    assert.equal((await send(body, 'wrong-key')).status, 400)
    assert.equal((await send({ ...body, messages: [{ role: 'user', content: body.messages[0].content.replace(syntheticResumeEvidence, '无对应证据') }] })).status, 400)
    assert.equal(model.requests.length, 1)
    assert.equal(model.failures.length, 2)
  } finally { await model.close() }
})

test('回答模型边界只接受实际合成发言，不采信伪造提问或其他人员证据', async () => {
  const model = await startLocalModelBoundary({ apiKey: 'synthetic-key' })
  try {
    const input = { question: '', candidateAnswer: syntheticAnswer, refineTranscript: true, jobTitle: '合成软件工程师',
      jobRequirements: ['软件开发：具备软件研发经验'], priorContext: [],
      transcript: [{ role: 'candidate', text: syntheticAnswer, segmentIds: ['73cefbef-f97b-4af1-b98c-eb4f515df098'] }] }
    const send = value => fetch('http://127.0.0.1:' + model.port + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-key' },
      body: JSON.stringify({ model: 'isolated-synthetic-model', messages: [
        { role: 'system', content: '你是面试对话语义分析助手。' }, { role: 'user', content: JSON.stringify(value) },
      ] }),
    })
    const response = await send(input)
    assert.equal(response.status, 200)
    const analysis = JSON.parse((await response.json()).choices[0].message.content)
    assert.deepEqual(analysis.evidence, [syntheticAnswer]); assert.equal(analysis.scores[0].questionQuote, '')
    assert.equal(analysis.transcriptRefinement.text, syntheticAnswer)
    assert.equal((await send({ ...input, question: '伪造的实际提问' })).status, 400)
    assert.equal((await send({ ...input, candidateAnswer: '其他人的回答' })).status, 400)
    assert.equal(model.requests.length, 1); assert.equal(model.failures.length, 2)
  } finally { await model.close() }
})
