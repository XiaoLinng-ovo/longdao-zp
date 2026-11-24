import assert from 'node:assert/strict'
import { test } from 'node:test'
import { successfulTapSummary } from '../test-business-postgres-isolated.mjs'

const tap = ({ tests = 4, pass = 4, fail = 0, cancelled = 0, skipped = 0, todo = 0 } = {}) =>
  Object.entries({ tests, pass, fail, cancelled, skipped, todo }).map(([name, value]) => '# ' + name + ' ' + value).join('\n')

test('隔离集成入口只接受已实际执行且零失败零跳过的完整统计', () => {
  assert.equal(successfulTapSummary(tap()).tests, 4)
  for (const stats of [{ tests: 0, pass: 0 }, { pass: 3, fail: 1 }, { pass: 3, skipped: 1 }, { cancelled: 1 }, { todo: 1 }]) {
    assert.throws(() => successfulTapSummary(tap(stats)))
  }
  assert.throws(() => successfulTapSummary(''))
  assert.throws(() => successfulTapSummary(tap() + '\n# tests 4'))
})
