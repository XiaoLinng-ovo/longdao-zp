import assert from 'node:assert/strict'
import { test } from 'node:test'
import { latestAnalysisByKey } from '../src/recruiting/latest-analysis.js'

test('latest analysis selection does not depend on iteration order or score magnitude', () => {
  const old = { id: 'a', createdAt: '2026-10-08T10:00:00+08:00', applicationId: 'app', score: 90 }
  const recent = { id: 'b', createdAt: '2026-10-08T03:00:00Z', applicationId: 'app', score: 24 }
  for (const rows of [[old, recent], [recent, old]]) {
    assert.equal(latestAnalysisByKey(rows, (row) => row.applicationId).get('app'), recent)
  }
})

test('equal timestamps have stable selection and missing associations are ignored', () => {
  const a = { id: 'a', createdAt: '2026-10-08T03:00:00Z', applicationId: 'app' }
  const b = { ...a, id: 'b' }
  for (const rows of [[a, b], [b, a]]) assert.equal(latestAnalysisByKey(rows, (row) => row.applicationId).get('app'), b)
  assert.equal(latestAnalysisByKey([a], () => undefined).size, 0)
})
