import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyUsageFailure, parseUsageFilters } from './ai-usage-diagnostics.js'
test('diagnostics classify bounded metadata without returning secrets or blaming provider for business failures', () => {
 const error = (code: string, cause?: unknown) => Object.assign(new Error('private key and provider body'), { code, cause })
 assert.equal(classifyUsageFailure(error('MODEL_HTTP_ERROR')), 'upstream_rejected')
 assert.equal(classifyUsageFailure(error('MODEL_RESPONSE_INVALID')), 'invalid_response')
 assert.equal(classifyUsageFailure(error('MODEL_REQUEST_FAILED', new DOMException('secret', 'TimeoutError'))), 'request_timeout')
 assert.equal(classifyUsageFailure(error('MODEL_REQUEST_FAILED', new DOMException('secret', 'AbortError'))), 'request_timeout')
 assert.equal(classifyUsageFailure(error('MODEL_REQUEST_FAILED', new TypeError('secret'))), 'network_error')
 assert.equal(classifyUsageFailure(error('DB_WRITE_FAILED')), 'generation_failed')
 assert.equal(classifyUsageFailure(error('MODEL_HTTP_ERROR'), true), 'settlement_failed')
 assert.equal(classifyUsageFailure('secret'), 'generation_failed')
})
test('usage filters reject invalid, duplicate and ambiguous timestamps', () => {
 for (const query of ['operation=x', 'state=x', 'reviewOnly=1', 'state=settled&state=uncertain', 'page=1&page=2', 'from=2026-02-30T00:00:00.000Z', 'from=2026-10-01', 'from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z']) assert.throws(() => parseUsageFilters(new URLSearchParams(query)), { status: 400 })
 assert.deepEqual(parseUsageFilters(new URLSearchParams('operation=jd&state=uncertain&reviewOnly=true&from=2026-10-01T00:00:00.000Z&to=2026-10-13T00:00:00.000Z')), { operation: 'jd', state: 'uncertain', reviewOnly: true, from: '2026-10-01T00:00:00.000Z', to: '2026-10-13T00:00:00.000Z' })
})
