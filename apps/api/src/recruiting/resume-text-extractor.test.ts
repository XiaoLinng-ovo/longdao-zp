import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractResumeText } from './resume-text-extractor.js'

function createTextPdf(text: string, extraPage?: 'image' | 'blank' | 'header-image' | 'portrait', cjk = false, extraStream = ''): Buffer {
  const literal = cjk ? `<${Buffer.from(text, 'utf16le').swap16().toString('hex')}>` : `(${text.replace(/[\\()]/gu, '\\$&')})`
  const stream = `BT /F1 12 Tf 72 720 Td ${literal} Tj ET\n${extraStream}`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R ${extraPage ? '6 0 R' : ''}] /Count ${extraPage ? 2 : 1} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    cjk ? '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor << /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /Ascent 900 /Descent -200 /CapHeight 700 /ItalicAngle 0 /StemV 80 >> >>] >>'
      : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  if (extraPage) {
    const stream = extraPage === 'blank' ? '' : (extraPage === 'portrait' ? 'q 60 0 0 80 500 680 cm /Im0 Do Q' : 'q 500 0 0 700 20 20 cm /Im0 Do Q')
      + (extraPage === 'header-image' || extraPage === 'portrait' ? '\nBT /F1 12 Tf 30 750 Td (Sample Candidate Software Engineer Python FastAPI) Tj ET' : '')
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << /Im0 8 0 R >> >> /Contents 7 0 R >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nx\nendstream',
    )
  }
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

test('extracts text from a valid PDF buffer through PDF.js', async () => {
  const text = await extractResumeText(createTextPdf('PDF Resume Software Engineer'), 'resume.pdf', 'application/pdf')
  assert.match(text, /PDF Resume Software Engineer/)
  assert.doesNotMatch(text, /--\s*\d+\s+of\s+\d+\s*--/u)
})

test('extracts CJK CID fonts using bundled CMaps without dropping Chinese or requiring OCR', async () => {
  const source = '张三 教育背景 计算机技术 硕士 专业技能 工作经验 项目经历 Python FastAPI'
  const text = await extractResumeText(createTextPdf(source, undefined, true), 'cmap.pdf', 'application/pdf', {
    async recognize() { assert.fail('A native CJK PDF must not require OCR') },
  })
  assert.equal(text, source)
})

test('API extraction drops repeated diagonal platform watermarks without changing the readable body', async () => {
  const overlay = [600, 500, 400].map((y) => `BT /F1 30 Tf 0.7071 0.7071 -0.7071 0.7071 50 ${y} Tm (Resume Platform) Tj ET\n`).join('')
    + 'BT /F1 30 Tf 0.7071 0.7071 -0.7071 0.7071 50 350 Tm (Platform) Tj ET\n'
  const source = 'Sample Candidate Software Engineer Go RAG'
  const text = await extractResumeText(createTextPdf(source, undefined, false, overlay), 'watermarked.pdf', 'application/pdf', {
    async recognize() { assert.fail('Readable body with a watermark must not require OCR') },
  })
  assert.equal(text, source)
})

test('does not count generated page labels towards the embedded-text OCR threshold', async () => {
  let calls = 0
  const text = await extractResumeText(createTextPdf('PDF Resume Engineer'), 'short.pdf', 'application/pdf', {
    async recognize() {
      calls += 1
      return { text: 'OCR Resume Software Engineer', engine: 'test' }
    },
  })
  assert.equal(calls, 1)
  assert.equal(text, 'OCR Resume Software Engineer')
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

test('watermark-only PDFs use OCR instead of treating identifiers as resume text', async () => {
  const watermark = 'b43175958f5b36471H1_09-7GFdYy4i3WfOXWOCkn_bUPhBh'
  const text = await extractResumeText(createTextPdf(watermark), 'watermark.pdf', 'application/pdf', {
    async recognize() { return { text: '张三 使用 Python 开发数据分析工具。', engine: 'test' } },
  })
  assert.match(text, /数据分析/u)
  assert.doesNotMatch(text, /b4317595/u)
})

test('mixed native/scanned pages use OCR, but blank trailing pages do not', async () => {
  let calls = 0
  const ocr = { async recognize() { calls++; return { text: 'Full OCR resume body with all page evidence', engine: 'test' } } }
  await extractResumeText(createTextPdf('Software engineer with five years experience', 'image'), 'mixed.pdf', 'application/pdf', ocr)
  assert.equal(calls, 1)
  const native = await extractResumeText(createTextPdf('Software engineer with five years experience', 'blank'), 'blank.pdf', 'application/pdf', ocr)
  assert.equal(calls, 1)
  assert.match(native, /Software engineer/u)
})

test('does not accept empty or watermark-only OCR output', async () => {
  for (const text of ['', 'b43175958f5b36471H1_09-7GFdYy4i3WfOXWOCkn_bUPhBh']) {
    await assert.rejects(extractResumeText(createTextPdf('x'), 'scan.pdf', 'application/pdf', {
      async recognize() { return { text, engine: 'test' } },
    }), /有效简历正文/u)
  }
})

test('a readable header cannot hide a missing scanned body; portrait photos do not force OCR', async () => {
  let calls = 0
  const ocr = { async recognize() { calls++; return { text: 'Full OCR resume including scanned work and education evidence', engine: 'test' } } }
  const text = await extractResumeText(createTextPdf('Software engineer with five years experience', 'header-image'), 'header-image.pdf', 'application/pdf', ocr)
  assert.equal(calls, 1)
  assert.match(text, /scanned work/u)
  const native = await extractResumeText(createTextPdf('Software engineer with five years experience', 'portrait'), 'portrait.pdf', 'application/pdf', ocr)
  assert.equal(calls, 1)
  assert.match(native, /Sample Candidate/u)
})

test('undecodable native glyphs require OCR even without images; damaged OCR cannot pass', async () => {
  let calls = 0
  const pdf = createTextPdf('Python (cid:123) (cid:124) (cid:125) FastAPI Software Engineer')
  assert.match(await extractResumeText(pdf, 'damaged.pdf', 'application/pdf', {
    async recognize() { calls++; return { text: 'Correctly recognized complete resume text', engine: 'test' } },
  }), /Correctly recognized/u)
  assert.equal(calls, 1)
  await assert.rejects(extractResumeText(pdf, 'damaged.pdf', 'application/pdf', {
    async recognize() { return { text: 'Python ' + '\uFFFD'.repeat(30), engine: 'test' } },
  }), /乱码.*尚未生成评分/u)
})
