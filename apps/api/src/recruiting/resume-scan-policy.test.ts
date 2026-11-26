import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { initialResumeScanStatus } from './resume-scan-policy.js'

describe('resume scan policy', () => {
  it('allows analysis by default when virus scanning is disabled', () => {
    assert.equal(initialResumeScanStatus({}), 'clean')
  })

  it('quarantines uploads only when virus scanning is explicitly enabled', () => {
    assert.equal(initialResumeScanStatus({ RESUME_VIRUS_SCAN_ENABLED: 'true' }), 'quarantined')
  })
})
