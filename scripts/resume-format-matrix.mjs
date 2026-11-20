import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { syntheticResumeText, syntheticPdf, syntheticDocx } from './synthetic-resume-formats.mjs'
import { verifyObjectCleanup } from './object-cleanup-verification.mjs'

export async function runResumeFormatMatrix({ companies, pool, request, expect, model, diagnostics, expectedDiagnostics,
  replaceWorker, ocr, inventory, deletingKeys, result, persist }) {
  result.cases = []; result.passed = false
  const company = companies[0], schema = '"' + company.schema + '"', records = [], successful = []
  const pdfMime = 'application/pdf', docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  async function check({ name, mime, content, failure, pages }) {
    const proof = { filename: name, bytes: content.length, hash: createHash('sha256').update(content).digest('hex'), expected: failure ? 'failed' : 'completed', passed: false }
    result.cases.push(proof); await persist()
    const batch = await expect(company, 'POST', '/resume-import-batches', { jobId: company.jobId,
      files: [{ clientFileId: randomUUID(), originalFilename: name, mimeType: mime, sizeBytes: content.length }] }, 201)
    if (pages) ocr.register(name, content, pages, syntheticResumeText)
    const before = model.requests.length, diagnosticStart = diagnostics.length, ocrBefore = ocr.requests.length
    const uploaded = await expect(company, 'POST', '/resume-import-batches/' + batch.id + '/items/' + batch.items[0].id + '/content', { encoding: 'base64', content: content.toString('base64') })
    assert.ok(uploaded.candidateId && uploaded.applicationId && uploaded.resumeId && uploaded.analysisTaskId)
    const deadline = Date.now() + 30000
    let task
    for (;;) {
      task = (await pool.query(`SELECT status,last_error,attempts FROM ${schema}.analysis_tasks WHERE id=$1`, [uploaded.analysisTaskId])).rows[0]
      assert.ok(task)
      if (['completed', 'failed'].includes(task.status)) break
      assert.ok(Date.now() < deadline, '格式任务未在30秒内终止：' + name); await delay(100)
    }
    assert.equal(task.status, proof.expected, name + ': ' + task.last_error)
    assert.equal(task.attempts, 1, '确定性格式错误不应自动重复收费或处理')
    const results = (await pool.query(`SELECT id FROM ${schema}.analysis_results WHERE analysis_task_id=$1 AND resume_id=$2 AND application_id=$3`, [uploaded.analysisTaskId, uploaded.resumeId, uploaded.applicationId])).rows
    const detail = await expect(company, 'GET', '/resume-import-batches/' + batch.id)
    assert.equal(detail.items[0].analysisStatus, proof.expected)
    assert.equal(detail.counts.completed, failure ? 0 : 1); assert.equal(detail.counts.failed, failure ? 1 : 0)
    assert.equal(detail.phase, failure ? 'completed_with_issues' : 'completed')
    if (failure) {
      assert.match(task.last_error, failure); assert.equal(results.length, 0); assert.equal(model.requests.length, before)
      while (diagnostics.length === diagnosticStart && Date.now() < deadline) await delay(20)
      const observed = diagnostics.slice(diagnosticStart)
      assert.equal(observed.length, 1, '每个预期解析错误只允许一条明确诊断')
      assert.equal(observed[0].level, 'error')
      assert.equal(observed[0].message, '[persisted-poll] poll tick failed: ' + task.last_error)
      expectedDiagnostics.push(observed[0]); proof.error = task.last_error; proof.noModelOrScoreOnFailure = true
    } else {
      assert.equal(results.length, 1); assert.equal(model.requests.length - before, 1)
      assert.equal(diagnostics.length, diagnosticStart)
      const candidate = (await pool.query(`SELECT id,candidate_no,name FROM ${schema}.candidates WHERE id=$1`, [uploaded.candidateId])).rows[0]
      assert.equal(candidate.name, '合成同名人员'); assert.match(candidate.candidate_no, /^C/)
      successful.push(candidate)
    }
    assert.equal(ocr.requests.length - ocrBefore, pages ? 1 : 0)
    assert.deepEqual(ocr.failures, []); assert.deepEqual(model.failures, [])
    const resume = (await pool.query(`SELECT storage_key,content_hash FROM ${schema}.resumes WHERE id=$1 AND candidate_id=$2 AND application_id=$3`, [uploaded.resumeId, uploaded.candidateId, uploaded.applicationId])).rows[0]
    assert.ok(resume); assert.equal(resume.content_hash, proof.hash)
    const stored = (await inventory()).find(file => file.key === resume.storage_key)
    assert.ok(stored); assert.equal(stored.hash, proof.hash)
    for (const method of ['GET', 'PATCH', 'DELETE']) assert.ok([403, 404].includes((await request(companies[1], method, '/candidates/' + uploaded.candidateId, method === 'PATCH' ? { name: '禁止跨公司修改' } : undefined)).status))
    records.push({ ...uploaded, storageKey: resume.storage_key }); proof.batchId = batch.id
    proof.associationsAndPhysicalHashMatch = true; proof.crossCompanyDenied = true; proof.passed = true
    await persist(); console.log('格式用例通过：' + name + '，结果：' + proof.expected)
  }
  await check({ name: 'format-valid.txt', mime: 'text/plain', content: Buffer.from(syntheticResumeText) })
  await check({ name: 'format-valid.md', mime: 'text/markdown', content: Buffer.from(syntheticResumeText) })
  await check({ name: 'format-valid.docx', mime: docxMime, content: await syntheticDocx() })
  await check({ name: 'format-cjk.pdf', mime: pdfMime, content: syntheticPdf() })
  await check({ name: 'format-scan-no-ocr.pdf', mime: pdfMime, content: syntheticPdf({ scanned: true }), failure: /OCR_SERVICE_URL.*未配置/u })
  await check({ name: 'format-corrupt.pdf', mime: pdfMime, content: Buffer.from('%PDF-not-valid'), failure: /pdf|parse|invalid/iu })
  await check({ name: 'format-corrupt.docx', mime: docxMime, content: Buffer.from('not-a-docx-zip'), failure: /zip|central directory|signature|valid/iu })

  // Legacy DOC must be rejected before creating a doomed analysis task.
  const legacy = await request(company, 'POST', '/resume-import-batches', { jobId: company.jobId,
    files: [{ clientFileId: randomUUID(), originalFilename: 'format-legacy.doc', mimeType: 'application/msword', sizeBytes: 8 }] })
  assert.equal(legacy.status, 400, '旧DOC没有解析器，不应接受后必然失败的导入批次')
  assert.match(legacy.body.error.message, /DOCX|PDF/u); result.legacyDocRejectedBeforeTask = true

  await replaceWorker({ port: ocr.port })
  await check({ name: 'format-scan-with-ocr.pdf', mime: pdfMime, content: syntheticPdf({ scanned: true }), pages: [1] })
  await check({ name: 'format-mixed-with-ocr.pdf', mime: pdfMime, content: syntheticPdf({ mixed: true }), pages: [2] })
  assert.equal(new Set(successful.map(row => row.id)).size, successful.length)
  assert.equal(new Set(successful.map(row => row.candidate_no)).size, successful.length)
  result.sameNamesKeptDistinct = true
  for (const record of records) {
    deletingKeys.add(record.storageKey)
    await expect(company, 'DELETE', '/candidates/' + record.candidateId)
    for (const [table, key, value] of [['candidates', 'id', record.candidateId], ['applications', 'candidate_id', record.candidateId],
      ['resumes', 'candidate_id', record.candidateId], ['analysis_tasks', 'resume_id', record.resumeId], ['analysis_results', 'resume_id', record.resumeId]]) {
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.${table} WHERE ${key}=$1`, [value])).rows[0].n, 0, '格式测试删除关联残留：' + table)
    }
  }
  result.physicalCleanup = {}
  await verifyObjectCleanup({ pool, keys: records.map(record => record.storageKey), inventory,
    proof: result.physicalCleanup, persist })
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.stored_object_locations WHERE storage_kind='resume'")).rows[0].n, 0)
  assert.deepEqual(diagnostics, expectedDiagnostics)
  result.deletionDatabaseAndPhysicalObjectsConsistent = true; result.ocrCalls = ocr.requests; result.passed = true
}
