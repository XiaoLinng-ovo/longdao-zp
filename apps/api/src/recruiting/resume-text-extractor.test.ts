import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractResumeText } from './resume-text-extractor.js'

function createTextPdf(text: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length + 34} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return Buffer.from(pdf)
}

test('extracts UTF-8 text files as text', async () => {
  const text = await extractResumeText(Buffer.from('张伟\nTypeScript Engineer'), 'resume.txt', 'text/plain')
  assert.equal(text, '张伟\nTypeScript Engineer')
})

test('extracts raw text from the real DOCX fixture', async () => {
  const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../测试简历-张伟.docx')
  const content = await readFile(fixture)
  const text = await extractResumeText(content, '测试简历-张伟.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.match(text, /张伟/)
  assert.ok(text.length > 20)
})

test('rejects binary content with unsupported extension instead of decoding as UTF-8', async () => {
  await assert.rejects(
    extractResumeText(Buffer.from([0, 159, 146, 150, 255]), 'resume.bin', 'application/octet-stream'),
    /unsupported|format|extension/i,
  )
})

test('reports malformed PDF explicitly', async () => {
  await assert.rejects(
    extractResumeText(Buffer.from('%PDF-not-valid'), 'resume.pdf', 'application/pdf'),
    /pdf|parse|invalid/i,
  )
})

test('extracts text from a valid PDF buffer through pdf-parse v2', async () => {
  const text = await extractResumeText(createTextPdf('PDF Resume Engineer'), 'resume.pdf', 'application/pdf')
  assert.match(text, /PDF Resume Engineer/)
})

test('falls back to OCR for a PDF with too little embedded text', async () => {
  let calls = 0
  const text = await extractResumeText(createTextPdf('x'), 'scan.pdf', 'application/pdf', {
    async recognize(input) {
      calls += 1
      assert.equal(input.filename, 'scan.pdf')
      return { text: '张伟 软件工程师 五年工作经验', engine: 'PP-StructureV3' }
    },
  })
  assert.equal(calls, 1)
  assert.match(text, /软件工程师/)
})
