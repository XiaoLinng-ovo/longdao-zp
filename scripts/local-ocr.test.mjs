import test from 'node:test'
import assert from 'node:assert/strict'
import { localOcrEndpoint } from './local-ocr.mjs'

test('local OCR startup only accepts plain local HTTP service origins', () => {
  assert.deepEqual(localOcrEndpoint('http://127.0.0.1:8090'), { healthUrl: 'http://127.0.0.1:8090/health', port: 8090 })
  assert.deepEqual(localOcrEndpoint('http://localhost:8091/'), { healthUrl: 'http://localhost:8091/health', port: 8091 })
  for (const value of [undefined, '', 'bad', 'https://localhost:8090', 'http://ocr:8090', 'http://example.com:8090', 'http://user:pass@localhost:8090', 'http://localhost:8090/prefix', 'http://localhost:8090/?x=1']) {
    assert.equal(localOcrEndpoint(value), undefined)
  }
})
