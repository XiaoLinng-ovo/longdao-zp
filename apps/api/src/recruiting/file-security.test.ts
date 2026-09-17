import test from 'node:test'
import assert from 'node:assert/strict'
import { createQuarantineFile, sha256Hex, validateResumeUpload } from './file-security.js'

test('accepts clean UTF-8 text upload and creates non-path object key', () => {
  const result = validateResumeUpload({ filename: 'resume.txt', mimeType: 'text/plain', content: Buffer.from('Alice\nEngineer') })
  assert.equal(result.extension, 'txt')
  assert.equal(result.sizeBytes, 14)
  assert.equal(result.scanStatus, 'quarantined')
  assert.match(result.objectKey, /^resumes\/quarantine\/[0-9a-f-]+\.txt$/)
})

test('rejects path traversal, double extensions, unsupported type, empty and oversized files', () => {
  assert.throws(() => validateResumeUpload({ filename: '../resume.txt', mimeType: 'text/plain', content: Buffer.from('x') }), /filename/i)
  assert.throws(() => validateResumeUpload({ filename: 'resume.pdf.exe', mimeType: 'application/pdf', content: Buffer.from('x') }), /extension/i)
  assert.throws(() => validateResumeUpload({ filename: 'resume.txt', mimeType: 'application/zip', content: Buffer.from('x') }), /type|mime/i)
  assert.throws(() => validateResumeUpload({ filename: 'resume.txt', mimeType: 'text/plain', content: Buffer.alloc(0) }), /empty|content/i)
  assert.throws(() => validateResumeUpload({ filename: 'resume.txt', mimeType: 'text/plain', content: Buffer.alloc(11) , maxBytes: 10 }), /size|large/i)
})

test('hashes bytes and exposes quarantine status transition', () => {
  const content = Buffer.from('resume')
  const result = createQuarantineFile({ filename: 'cv.md', mimeType: 'text/markdown', content })
  assert.equal(result.contentHash, sha256Hex(content))
  assert.equal(result.scanStatus, 'quarantined')
  assert.equal(result.withScanResult('clean').scanStatus, 'clean')
  assert.equal(result.withScanResult('infected').scanStatus, 'infected')
  assert.throws(() => result.withScanResult('quarantined' as never), /transition/i)
})

test('normalizes unicode names while keeping object key opaque and filename-free', () => {
  const result = validateResumeUpload({ filename: '张三 简历.txt', mimeType: 'text/plain', content: Buffer.from('resume') })
  assert.equal(result.safeFilename, '张三 简历.txt')
  assert.match(result.objectKey, /^resumes\/quarantine\/[0-9a-f-]+\.txt$/)
  assert.equal(result.objectKey.includes('张三'), false)
})

test('rejects MIME and extension mismatch and prevents post-scan regression', () => {
  assert.throws(() => validateResumeUpload({ filename: 'resume.pdf', mimeType: 'text/plain', content: Buffer.from('x') }), /mime|type/i)
  const clean = createQuarantineFile({ filename: 'resume.txt', mimeType: 'text/plain', content: Buffer.from('x') }).withScanResult('clean')
  assert.throws(() => clean.withScanResult('infected'), /transition/i)
})
