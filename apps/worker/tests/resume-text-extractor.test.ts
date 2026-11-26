import assert from 'node:assert/strict'
import test from 'node:test'
import { extractResumeText } from '../src/resume-text-extractor.js'

function positionedPdf(customStream?: string, extraPage?: 'image' | 'blank' | 'header-image' | 'portrait', cjk = false, rasterBody = false): Buffer {
  // Draw headings last, reproducing template PDFs whose content-stream order
  // differs from their visible top-to-bottom layout.
  const stream = (rasterBody ? 'q 612 0 0 792 0 0 cm /ResumeImage Do Q\n' : '') + (customStream ?? ('BT /F1 12 Tf 50 650 Td (Python, FastAPI, Milvus) Tj ET\n'
    + 'BT /F1 12 Tf 50 550 Td (Built a document search system.) Tj ET\n'
    + 'BT /F1 12 Tf 50 700 Td (Skills) Tj ET\n'
    + 'BT /F1 12 Tf 50 600 Td (Work Experience) Tj ET\n'))
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R ${extraPage ? '6 0 R' : ''}] /Count ${extraPage ? 2 : 1} >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> ${rasterBody ? `/XObject << /ResumeImage ${extraPage ? 9 : 6} 0 R >>` : ''} >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    cjk ? '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor << /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /Ascent 900 /Descent -200 /CapHeight 700 /ItalicAngle 0 /StemV 80 >> >>] >>'
      : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  if (extraPage) {
    const content = extraPage === 'blank' ? '' : (extraPage === 'portrait' ? 'q 60 0 0 80 500 680 cm /Im0 Do Q' : 'q 500 0 0 700 20 20 cm /Im0 Do Q')
      + (extraPage === 'header-image' || extraPage === 'portrait' ? '\nBT /F1 12 Tf 30 750 Td (Sample Candidate Software Engineer Python FastAPI) Tj ET' : '')
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << /Im0 8 0 R >> >> /Contents 7 0 R >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nx\nendstream',
    )
  }
  if (rasterBody) objects.push('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nx\nendstream')
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}

test('extracts real PDF text in visible order and adds no generated page markers', async () => {
  const text = await extractResumeText(positionedPdf(), 'resume.pdf', 'application/pdf')
  assert.match(text, /Skills\nPython, FastAPI, Milvus\nWork Experience\nBuilt a document search system\./u)
  assert.doesNotMatch(text, /--\s*\d+\s+of\s+\d+\s*--/u)
})

test('CJK CID-font PDFs retain Chinese through the background extraction path', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Native CJK extraction must not use OCR') })
  const source = '张三 教育背景 计算机技术 硕士 专业技能 工作经验 项目经历 Python FastAPI'
  const hex = Buffer.from(source, 'utf16le').swap16().toString('hex')
  const text = await extractResumeText(positionedPdf(`BT /F1 12 Tf 50 700 Td <${hex}> Tj ET\n`, undefined, true), 'cmap.pdf', 'application/pdf')
  assert.equal(text, source)
})

test('background extraction filters diagonal platform watermarks before reconstructing text', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Readable watermarked text must not use OCR') })
  const stream = 'BT /F1 12 Tf 50 700 Td (Sample Candidate Software Engineer Go RAG) Tj ET\n'
    + [600, 500, 400].map((y) => `BT /F1 30 Tf 0.7071 0.7071 -0.7071 0.7071 50 ${y} Tm (Resume Platform) Tj ET\n`).join('')
    + 'BT /F1 30 Tf 0.7071 0.7071 -0.7071 0.7071 50 350 Tm (Platform) Tj ET\n'
  assert.equal(await extractResumeText(positionedPdf(stream), 'watermarked.pdf', 'application/pdf'), 'Sample Candidate Software Engineer Go RAG')
})

test('rejects malformed PDF data explicitly', async () => {
  await assert.rejects(extractResumeText(Buffer.from('%PDF-invalid'), 'resume.pdf', 'application/pdf'), /invalid|pdf/i)
})

test('extracts a real two-column PDF without interleaving independent sections', async () => {
  const line = (text: string, x: number, y: number) => `BT /F1 10 Tf ${x} ${y} Td (${text}) Tj ET\n`
  const stream = line('Sample Candidate', 30, 760)
    + Array.from({ length: 12 }, (_, index) => line(`Left school details ${index}`, 30, 680 - index * 15)
      + line(`Right project evidence ${index}`, 250, 680 - index * 15)).join('')
    + line('Education', 30, 710) + line('Projects', 250, 710)
  const text = await extractResumeText(positionedPdf(stream), 'columns.pdf', 'application/pdf')
  assert.ok(text.indexOf('Sample Candidate') < text.indexOf('Education'))
  assert.ok(text.indexOf('Left school details 11') < text.indexOf('Projects'))
  assert.match(text, /Projects\nRight project evidence 0/u)
  assert.doesNotMatch(text, /Left[^\n]*Right/u)
})

test('watermark and mixed-page PDFs use OCR; a blank trailing page does not', async (t) => {
  const previous = process.env.OCR_SERVICE_URL
  process.env.OCR_SERVICE_URL = 'http://ocr.local'
  t.after(() => { if (previous === undefined) delete process.env.OCR_SERVICE_URL; else process.env.OCR_SERVICE_URL = previous })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ text: '张三 使用 Python 开发数据处理工具。' }) })
  const watermark = 'b43175958f5b36471H1_09-7GFdYy4i3WfOXWOCkn_bUPhBh'
  assert.match(await extractResumeText(positionedPdf(`BT /F1 12 Tf 50 700 Td (${watermark}) Tj ET\n`), 'watermark.pdf'), /Python/u)
  assert.equal(calls, 1)
  await extractResumeText(positionedPdf(undefined, 'image'), 'mixed.pdf')
  assert.equal(calls, 2)
  await extractResumeText(positionedPdf(undefined, 'blank'), 'blank.pdf')
  assert.equal(calls, 2)
})

test('OCR failures are explicit and cannot masquerade as successful analysis', async (t) => {
  const previous = process.env.OCR_SERVICE_URL
  t.after(() => { if (previous === undefined) delete process.env.OCR_SERVICE_URL; else process.env.OCR_SERVICE_URL = previous })
  delete process.env.OCR_SERVICE_URL
  await assert.rejects(extractResumeText(Buffer.from('image'), 'scan.png'), { code: 'OCR_NOT_CONFIGURED' })
  process.env.OCR_SERVICE_URL = 'http://ocr.local'
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('private connection details') })
  await assert.rejects(extractResumeText(Buffer.from('image'), 'scan.png'), { code: 'OCR_UNAVAILABLE', retryableOverride: false })
  fetchMock.mock.mockImplementation(async () => Response.json({ text: 'h' }))
  await assert.rejects(extractResumeText(Buffer.from('image'), 'scan.png'), { code: 'OCR_TEXT_EMPTY', retryableOverride: false })
  fetchMock.mock.mockImplementation(async () => new Response('busy', { status: 429 }))
  await assert.rejects(extractResumeText(Buffer.from('image'), 'scan.png'), { code: 'OCR_HTTP_ERROR', retryableOverride: true })
})

test('a full-page raster resume with repeated download watermarks must use OCR, never score watermark text', async (t) => {
  const previous = process.env.OCR_SERVICE_URL
  process.env.OCR_SERVICE_URL = 'http://ocr.local'
  t.after(() => { if (previous === undefined) delete process.env.OCR_SERVICE_URL; else process.env.OCR_SERVICE_URL = previous })
  const watermark = 'b43175958f5b36471H1_09-7GFdYy4i3WfOXWOCkn_bUPhBh'
  const stream = Array.from({ length: 8 }, (_, index) => `BT /F1 8 Tf 20 ${750 - index * 90} Td (${watermark}) Tj ET\n`).join('')
  const content = positionedPdf(stream, undefined, false, true)
  const recognized = 'Sample Candidate\nEducation Computer Science\nProjects Python FastAPI document retrieval'
  let calls = 0
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls++
    assert.equal(url, 'http://ocr.local/ocr')
    assert.ok(init?.body instanceof FormData)
    const file = init.body.get('file') as File
    assert.equal(file.name, 'raster-watermark.pdf')
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), content)
    return Response.json({ text: recognized })
  })
  assert.equal(await extractResumeText(content, 'raster-watermark.pdf', 'application/pdf'), recognized)
  assert.equal(calls, 1)
  fetchMock.mock.mockImplementation(async () => Response.json({ text: Array(8).fill(watermark).join('\n') }))
  await assert.rejects(extractResumeText(content, 'raster-watermark.pdf', 'application/pdf'), { code: 'OCR_TEXT_EMPTY' })
  delete process.env.OCR_SERVICE_URL
  await assert.rejects(extractResumeText(content, 'raster-watermark.pdf', 'application/pdf'), { code: 'OCR_NOT_CONFIGURED' })
})

test('detects raster bodies behind readable headers, without treating portraits as scanned pages', async (t) => {
  const previous = process.env.OCR_SERVICE_URL
  process.env.OCR_SERVICE_URL = 'http://ocr.local'
  t.after(() => { if (previous === undefined) delete process.env.OCR_SERVICE_URL; else process.env.OCR_SERVICE_URL = previous })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ text: 'Full OCR resume including scanned work and education evidence' }) })
  assert.match(await extractResumeText(positionedPdf(undefined, 'header-image'), 'header.pdf'), /scanned work/u)
  assert.equal(calls, 1)
  assert.match(await extractResumeText(positionedPdf(undefined, 'portrait'), 'portrait.pdf'), /Sample Candidate/u)
  assert.equal(calls, 1)
})

test('font decoding damage uses OCR and garbled OCR fails explicitly', async (t) => {
  const previous = process.env.OCR_SERVICE_URL
  process.env.OCR_SERVICE_URL = 'http://ocr.local'
  t.after(() => { if (previous === undefined) delete process.env.OCR_SERVICE_URL; else process.env.OCR_SERVICE_URL = previous })
  const source = 'Python (cid:123) (cid:124) (cid:125) FastAPI Software Engineer'
  const literal = source.replace(/[\\()]/gu, '\\$&')
  const pdf = positionedPdf(`BT /F1 12 Tf 30 750 Td (${literal}) Tj ET\n`)
  let calls = 0
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ text: 'Correctly recognized complete resume text' }) })
  assert.match(await extractResumeText(pdf, 'damaged.pdf'), /Correctly recognized/u)
  assert.equal(calls, 1)
  fetchMock.mock.mockImplementation(async () => Response.json({ text: 'Python ' + '\uFFFD'.repeat(30) }))
  await assert.rejects(extractResumeText(pdf, 'damaged.pdf'), { code: 'OCR_TEXT_GARBLED', retryableOverride: false })
})
