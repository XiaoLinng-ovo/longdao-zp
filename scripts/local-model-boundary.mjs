import assert from 'node:assert/strict'
import { createServer } from 'node:http'

export const syntheticResumeEvidence = '经验：五年软件研发，Java、PostgreSQL、Vue，负责系统开发与测试。'
export const syntheticAnswer = '我负责合成项目的数据库并发导入，通过事务和唯一任务编号避免重复处理，并验证了失败回滚。'

export async function startLocalModelBoundary({ apiKey, beforeResumeReply }) {
  const requests = [], failures = []
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(request.headers.authorization, 'Bearer ' + apiKey)
      let size = 0
      const chunks = []
      for await (const chunk of request) {
        size += chunk.length
        assert.ok(size <= 1024 * 1024, '合成模型请求过大')
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.equal(body.model, 'isolated-synthetic-model')
      const prompt = body.messages.find(message => message.role === 'user')?.content
      assert.equal(typeof prompt, 'string')
      const system = body.messages.find(message => message.role === 'system')?.content
      if (typeof system === 'string' && system.includes('你是面试对话语义分析助手')) {
        const input = JSON.parse(prompt)
        assert.equal(input.candidateAnswer, syntheticAnswer)
        assert.equal(input.question, '', '参考问题和客户端输入不能冒充实际提问')
        assert.equal(input.speechRole, undefined)
        assert.equal(input.refineTranscript, true)
        assert.equal(input.jobTitle, '合成软件工程师')
        assert.ok(Array.isArray(input.jobRequirements) && input.jobRequirements.length > 0)
        assert.deepEqual(input.priorContext, [])
        assert.equal(input.transcript.length, 1)
        const turn = input.transcript[0]
        assert.equal(turn.role, 'candidate'); assert.equal(turn.text, syntheticAnswer)
        assert.equal(turn.segmentIds.length, 1)
        assert.match(turn.segmentIds[0], /^[a-f0-9-]{36}$/i)
        const suggestion = {
          questionKind: 'assessment', summary: '仅用于隔离流程验收的合成回答分析', evidence: [syntheticAnswer],
          scores: [{ dimension: '并发导入一致性', score: 8, rationale: '隔离合成评分', evidence: [syntheticAnswer], questionQuote: '' }],
          concerns: [], confidence: 0.8, nextQuestion: '请进一步说明失败恢复。',
          transcriptRefinement: { text: syntheticAnswer, corrections: [], uncertainties: [] },
        }
        requests.push({ kind: 'answer', segmentIds: turn.segmentIds, actualSpeechEvidence: true, actualQuestion: '' })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(suggestion) } }] }))
        return
      }
      const jobLine = prompt.split('\n').find(line => line.startsWith('岗位信息：'))
      assert.ok(jobLine, '缺少真实岗位信息')
      const job = JSON.parse(jobLine.slice('岗位信息：'.length))
      assert.equal(job.title, '合成软件工程师')
      assert.equal(job.requirements.length, 1, '合成边界只接受预设测试岗位')
      assert.equal(job.requirements[0].label, '软件开发：具备软件研发经验')
      const resume = prompt.split('脱敏简历：\n')[1]
      assert.ok(resume?.includes(syntheticResumeEvidence), '证据必须存在于真实Worker发送的脱敏原文')
      const suggestion = {
        score: 90, confidence: 0.8,
        requirementAssessments: job.requirements.map(item => ({
          requirementId: item.id, status: 'met', score: 90,
          sourceTexts: [syntheticResumeEvidence], rationale: '仅用于隔离流程验收的合成评分',
        })),
      }
      requests.push({ kind: 'resume', requirementIds: job.requirements.map(item => item.id), evidencePresent: true })
      if (beforeResumeReply) await beforeResumeReply()
      if (response.destroyed) return
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(suggestion) } }] }))
    } catch (error) {
      failures.push(error.message)
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: '合成模型边界拒绝了非预设请求' }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    port: server.address().port, requests, failures,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
