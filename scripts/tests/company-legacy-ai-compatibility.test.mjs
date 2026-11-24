import assert from 'node:assert/strict'
import test from 'node:test'
import { legacyBaselineMatches } from '../company-data-model.mjs'

const organization = '00000000-0000-4000-8000-000000000028'
const oldAi = { rows: '1', sha256: 'old-ai' }
const newAi = { rows: '1', sha256: 'new-ai' }
const other = { rows: '1', sha256: 'other' }
function client(ai, fallback, changedOther = other) {
  const queries = []
  return { queries, async query(sql, values) {
    queries.push(sql)
    if (sql.includes('information_schema.columns')) return { rowCount: 1 }
    assert.deepEqual(values, [organization])
    if (sql.includes('CASE WHEN')) {
      assert.ok(sql.includes("to_jsonb(t)->'self_service_enabled'='false'::jsonb"))
      return { rows: [fallback] }
    }
    return { rows: [sql.includes('"enterprise_ai_settings"') ? ai : changedOther] }
  } }
}
const expected = [{ table: 'candidates', ...other }, { table: 'enterprise_ai_settings', ...oldAi }]
test('an exact baseline needs no compatibility projection', async () => {
  const db = client(oldAi, oldAi)
  assert.equal(await legacyBaselineMatches(db, organization, ['enterprise_ai_settings','candidates'], expected), true)
  assert.equal(db.queries.some(sql => sql.includes('CASE WHEN')), false)
})
test('0107 default false can match an immutable pre-0107 receipt', async () => {
  assert.equal(await legacyBaselineMatches(client(newAi, oldAi), organization, ['enterprise_ai_settings','candidates'], expected), true)
})
test('changes to any other table still fail', async () => {
  assert.equal(await legacyBaselineMatches(client(newAi, oldAi, { rows: '2', sha256: 'changed' }), organization, ['enterprise_ai_settings','candidates'], expected), false)
})
test('key/model changes, enabled settings and changed counts cannot match', async () => {
  for (const changed of [{ rows:'1',sha256:'different-key-or-enabled' }, { rows:'2',sha256:'old-ai' }]) {
    assert.equal(await legacyBaselineMatches(client(newAi, changed), organization, ['enterprise_ai_settings','candidates'], expected), false)
  }
})
test('new receipts keep the full-field fingerprint', async () => {
  const db = client(newAi, oldAi)
  assert.equal(await legacyBaselineMatches(db, organization, ['enterprise_ai_settings','candidates'], [{ table:'candidates',...other },{ table:'enterprise_ai_settings',...newAi }]), true)
  assert.equal(db.queries.some(sql => sql.includes('CASE WHEN')), false)
})
