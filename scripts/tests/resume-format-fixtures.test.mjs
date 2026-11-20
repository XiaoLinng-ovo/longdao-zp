import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { projectRoot } from '../isolated-environment.mjs'
import { syntheticResumeText, syntheticPdf, syntheticDocx } from '../synthetic-resume-formats.mjs'
import { startLocalOcrBoundary } from '../local-ocr-boundary.mjs'

test('合成DOCX与中文文本PDF经真实后台解析器提取，不使用OCR', async () => {
  assert.ok(!process.env.OCR_SERVICE_URL, '测试不得继承业务OCR')
  const { extractResumeText } = await import(pathToFileURL(join(projectRoot, 'apps/worker/dist/src/resume-text-extractor.js')).href)
  assert.equal((await extractResumeText(await syntheticDocx(), 'synthetic.docx')).trim(), syntheticResumeText.replaceAll('\n', '\n\n'))
  const pdf = await extractResumeText(syntheticPdf(), 'synthetic.pdf', 'application/pdf')
  for (const line of syntheticResumeText.split('\n')) assert.ok(pdf.includes(line), '原生PDF必须保留合成正文：' + line)
  await assert.rejects(extractResumeText(syntheticPdf({ scanned: true }), 'scan.pdf', 'application/pdf'), /未配置/u)
})

test('本机OCR只接受登记文件的实际字节、文件名和页码', async () => {
  const boundary = await startLocalOcrBoundary()
  try {
    const content = syntheticPdf({ scanned: true })
    boundary.register('scan.pdf', content, [1], syntheticResumeText)
    async function send(bytes, pages) {
      const form = new FormData(); form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'scan.pdf'); form.append('pages', JSON.stringify(pages))
      return fetch('http://127.0.0.1:' + boundary.port + '/ocr', { method: 'POST', body: form })
    }
    const valid = await send(content, [1]); assert.equal(valid.status, 200)
    assert.deepEqual((await valid.json()).pages, [{ page: 1, text: syntheticResumeText }])
    const invalidBytes = await send(Buffer.from('wrong-file'), [1]); assert.equal(invalidBytes.status, 400); await invalidBytes.json()
    const invalidPages = await send(content, [2]); assert.equal(invalidPages.status, 400); await invalidPages.json()
    assert.equal(boundary.requests.length, 1); assert.equal(boundary.failures.length, 2)
  } finally { await boundary.close() }
})
