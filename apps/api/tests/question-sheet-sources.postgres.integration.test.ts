import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { QuestionSheetRepository } from '../src/interviews/question-sheet-repository.js'

test('PostgreSQL 面试表按阶段和组织取题库，回答只配对同一会话，不跨场次串题', async context => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool()
  const client = await pool.connect()
  await client.query('BEGIN')
  try {
    // Temporary tables shadow production tables only on this rolled-back connection.
    await client.query('CREATE TEMP TABLE applications (id uuid, organization_id uuid) ON COMMIT DROP')
    await client.query('CREATE TEMP TABLE interviews (id uuid, application_id uuid, organization_id uuid, stage text, status text, created_at timestamptz DEFAULT now()) ON COMMIT DROP')
    await client.query('CREATE TEMP TABLE interview_live_sessions (id uuid, interview_id uuid, started_at timestamptz DEFAULT now()) ON COMMIT DROP')
    await client.query('CREATE TEMP TABLE interview_live_question_events (id uuid, session_id uuid, question text, created_at timestamptz) ON COMMIT DROP')
    await client.query('CREATE TEMP TABLE interview_live_segments (id uuid, session_id uuid, text text, role text, role_confidence numeric, created_at timestamptz, speaker_id text, start_ms integer, end_ms integer, status text) ON COMMIT DROP')
    await client.query('CREATE TEMP TABLE interview_resume_question_sets (interview_id uuid, questions jsonb) ON COMMIT DROP')
    const app = randomUUID(), org = randomUUID(), otherOrg = randomUUID()
    await client.query('INSERT INTO applications VALUES ($1,$2)', [app, org])
    const fixtures = [
      { stage: 'initial', org, status: 'scheduled', label: '初试甲' },
      { stage: 'initial', org, status: 'scheduled', label: '初试乙' },
      { stage: 'final', org, status: 'scheduled', label: '复试' },
      { stage: 'initial', org, status: 'cancelled', label: '已取消' },
      { stage: 'initial', org: otherOrg, status: 'scheduled', label: '其他组织' },
    ]
    for (const fixture of fixtures) {
      const interview = randomUUID(), session = randomUUID()
      await client.query('INSERT INTO interviews (id,application_id,organization_id,stage,status) VALUES ($1,$2,$3,$4,$5)', [interview, app, fixture.org, fixture.stage, fixture.status])
      await client.query('INSERT INTO interview_live_sessions (id,interview_id) VALUES ($1,$2)', [session, interview])
      await client.query("INSERT INTO interview_live_question_events VALUES ($1,$2,$3,'2026-10-16T01:00:00Z')", [randomUUID(), session, `${fixture.label}参考但未提问`])
      await client.query("INSERT INTO interview_live_segments VALUES ($1,$2,$3,'candidate',0.9,'2026-10-16T01:00:01Z','candidate-1',2000,3000,'final')", [randomUUID(), session, `${fixture.label}回答`])
      await client.query("INSERT INTO interview_live_segments VALUES ($1,$2,$3,'interviewer',1,'2026-10-16T01:00:11Z','interviewer-1',0,1000,'final'),($4,$2,'低置信度内容','candidate',0.2,'2026-10-16T01:00:12Z','candidate-1',5000,6000,'final')", [randomUUID(), session, `${fixture.label}实际提问`, randomUUID()])
      const questions = ['ai', 'hr', 'department', 'boss'].map(group => ({ group, question: `${fixture.label}${group}题`, category: 'experience', difficulty: 'medium', groundedIn: ['岗位要求'], rationale: '考核', scoringRubric: [{ criterion: '证据', points: 10 }] }))
      await client.query('INSERT INTO interview_resume_question_sets VALUES ($1,$2::jsonb)', [interview, JSON.stringify(questions)])
    }
    const repository = new QuestionSheetRepository({ query: (sql: string, values: unknown[]) => client.query(sql, values) } as never)
    const actual = await repository.listQaPairs(app, 'initial')
    assert.equal(actual.length, 2)
    for (const pair of actual) { assert.equal(pair.answerSegmentIds.length, 1); assert.equal(pair.answerText, pair.question.replace('实际提问', '回答')) }
    for (const [stage, sheetType, group, expected] of [
      ['initial', 'hr_screen', 'hr', 6], ['initial', 'hiring_department', 'department', 6],
      ['final', 'hr', 'hr', 3], ['final', 'business', 'department', 3], ['final', 'boss', 'boss', 3],
    ] as const) {
      const rows = await repository.listSheetQaPairs(app, stage, sheetType)
      assert.equal(rows.length, expected)
      assert.ok(rows.some(row => row.question.endsWith(`${group}题`)))
      assert.ok(rows.every(row => !/其他组织|已取消/.test(row.question)))
      assert.ok(rows.filter(row => row.source !== 'live_question').every(row => !row.answerText && !row.answerSegmentIds.length))
      assert.ok(rows.every(row => stage === 'final' ? row.question.startsWith('复试') : row.question.startsWith('初试')))
    }
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  }
})
