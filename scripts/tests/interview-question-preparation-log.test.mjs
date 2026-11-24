import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntimeLog } from '../runtime-log.mjs'
import { MemoryPreparationRepository } from '../../apps/api/dist/src/interviews/question-preparation-repository.js'
import { QuestionPreparationService } from '../../apps/api/dist/src/interviews/question-preparation-service.js'
import { generateLocalInterviewQuestions, InterviewQuestionGenerationError } from '../../apps/api/dist/src/interviews/question-generator.js'

for (const code of ['MODEL_RESPONSE_INVALID', 'MODEL_REQUEST_FAILED']) {
  test('managed runtime persists sanitized ' + code + ' diagnostics after a successful retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interview-preparation-log-'))
    try {
      const file = join(directory, 'api.jsonl')
      const log = createRuntimeLog(file, {})
      const repository = new MemoryPreparationRepository()
      const input = { jobTitle: 'Developer', jobRequirements: ['APIs'], anonymizedResume: 'Built order APIs.', analysisSummary: [], questionCount: 10 }
      let fail = true
      const service = new QuestionPreparationService(repository, {
        questions: { get: async () => null },
        interview: async () => ({ id: 'interview-1', applicationId: 'application-1', status: 'scheduled', round: 1 }),
        context: async () => input,
        prepareRubrics: async () => 'ready',
        generate: async (_id, context, group) => {
          if (fail) throw new InterviewQuestionGenerationError(code, 'private-resume-model-output-and-api-key', undefined, { model: 'configured-model', reason: 'network' })
          return { questions: generateLocalInterviewQuestions({ ...context, includeCommonQuestions: true }).questions.filter(question => question.group === group) }
        },
        logger: { error: (...args) => log('error', ...args) },
      })
      await service.request('interview-1', 'actor')
      await service.processPending()
      const failed = await service.status('interview-1')
      assert.equal(failed.status, 'failed')
      const diagnosticId = failed.failure.diagnosticId
      fail = false
      await service.request('interview-1', 'actor', true)
      await service.processPending()
      assert.equal((await service.status('interview-1')).status, 'ready')
      assert.equal((await service.status('interview-1')).failure, undefined)
      const content = await readFile(file, 'utf8')
      assert.doesNotMatch(content, /structured log omitted|private-resume-model-output-and-api-key|Built order APIs/)
      const entry = JSON.parse(content.trim())
      const prefix = 'interview-question-preparation-failed '
      assert.equal(entry.level, 'error')
      assert.ok(entry.message.startsWith(prefix))
      const diagnostic = JSON.parse(entry.message.slice(prefix.length))
      assert.equal(diagnostic.diagnosticId, diagnosticId)
      assert.equal(diagnostic.code, code)
      assert.equal(diagnostic.stage, 'question_generation')
      assert.equal(diagnostic.group, 'ai')
      assert.equal(diagnostic.model, 'configured-model')
      assert.equal(diagnostic.summary, failed.error)
      await service.close()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}
