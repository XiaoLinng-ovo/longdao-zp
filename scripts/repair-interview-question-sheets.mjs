import '../apps/api/dist/src/env.js'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabasePool } from '../apps/api/dist/src/db/connection.js'
import { QuestionSheetRepository } from '../apps/api/dist/src/interviews/question-sheet-repository.js'
import { normalizeSheetQuestion } from '../apps/api/dist/src/interviews/question-sheet-input.js'
import { DEFAULT_QUESTION_TIERS } from '../apps/api/dist/src/interviews/question-sheet-generator.js'

const args = process.argv.slice(2)
const organizationId = args[args.indexOf('--organization') + 1]
if (!args.includes('--organization') || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(organizationId ?? '')) {
  throw new Error('Usage: node scripts/repair-interview-question-sheets.mjs --organization <uuid> [--apply]')
}
const apply = args.includes('--apply')
const root = fileURLToPath(new URL('../', import.meta.url))
const pool = createDatabasePool()
try {
  const repository = new QuestionSheetRepository(pool)
  const result = await pool.query(
    `SELECT s.* FROM interview_question_sheets s
       JOIN applications a ON a.id = s.application_id
      WHERE a.organization_id = $1::uuid AND s.status IN ('draft', 'scoring') ORDER BY s.created_at`,
    [organizationId],
  )
  const plans = []
  for (const sheet of result.rows) {
    const current = await pool.query('SELECT * FROM interview_questions WHERE sheet_id = $1::uuid ORDER BY seq', [sheet.id])
    const included = new Set(current.rows.map(row => normalizeSheetQuestion(row.question)))
    const pairs = await repository.listSheetQaPairs(sheet.application_id, sheet.stage, sheet.sheet_type)
    const missing = pairs.filter(pair => !included.has(normalizeSheetQuestion(pair.question)))
    if (missing.length) plans.push({ sheet, current: current.rows, missing })
  }
  let backup = null
  if (apply && plans.length) {
    const dir = path.join(root, 'tmp', 'question-sheet-source-repair')
    await mkdir(dir, { recursive: true })
    backup = path.join(dir, `before-repair-${Date.now()}.json`)
    await writeFile(backup, JSON.stringify({ savedAt: new Date().toISOString(), organizationId, plans }, null, 2), { flag: 'wx' })
  }
  const repaired = []
  for (const plan of plans) {
    let added = 0
    if (apply) {
      added = await repository.appendMissingQuestions(plan.sheet.id, plan.missing.map((pair, index) => ({
        seq: index + 1, question: pair.question, source: pair.questionEventId ? 'live_question' : 'ai_generated',
        questionEventId: pair.questionEventId, answerSegmentIds: pair.answerSegmentIds, answerText: pair.answerText || null,
        dimension: pair.dimension ?? '综合能力', category: pair.category ?? 'experience', difficulty: pair.difficulty ?? 'medium',
        tiers: DEFAULT_QUESTION_TIERS.map(tier => ({ ...tier })), aiTier: null, aiScore: null, aiRationale: null, aiEvidence: [],
      })))
      const after = await pool.query('SELECT * FROM interview_questions WHERE sheet_id = $1::uuid ORDER BY seq', [plan.sheet.id])
      for (const original of plan.current) assert.deepEqual(after.rows.find(row => row.id === original.id), original, 'Existing question or human evaluation changed')
      for (const row of after.rows.filter(row => !plan.current.some(original => original.id === row.id))) {
        assert.equal(row.ai_score, null)
        assert.equal(row.ai_tier, null)
        assert.equal(row.final_score, null)
      }
    }
    repaired.push({ id: plan.sheet.id, applicationId: plan.sheet.application_id, stage: plan.sheet.stage, sheetType: plan.sheet.sheet_type, before: plan.current.length, missing: plan.missing.length, added })
  }
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', backup, repaired }, null, 2))
} finally {
  await pool.end()
}
