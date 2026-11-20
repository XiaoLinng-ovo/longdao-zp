import '../apps/api/dist/src/env.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createPostgresHealthPool } from '../apps/api/dist/src/recruiting/db-health.js'
import { createObjectStorageFromEnv } from '../packages/object-storage/dist/index.js'
import { extractResumeText } from '../apps/worker/dist/src/resume-text-extractor.js'
import { extractResume, parseResume, isResumePlaceholderName, EXTRACTOR_VERSION } from '../packages/resume-intelligence/dist/index.js'

// Inspect every original file without enqueuing scoring or altering records.
const pool = createPostgresHealthPool()
const storage = createObjectStorageFromEnv(process.env, resolve('data/resumes/quarantine'))
const directory = resolve('reports', `resume-audit-${Date.now()}`)
const cacheDirectory = process.env.RESUME_AUDIT_CACHE_DIR
const forceSourceIds = new Set((process.env.RESUME_AUDIT_FORCE_SOURCE_IDS ?? '').split(',').filter(Boolean))
const onlyIds = new Set((process.env.RESUME_AUDIT_ONLY_IDS ?? '').split(',').filter(Boolean))
await mkdir(directory, { recursive: true })
try {
  const { rows } = await pool.query(`SELECT r.*, c.name AS current_name, c.organization_id AS candidate_org, t.status AS task_status, t.last_error, ar.result AS stored_result
    FROM resumes r LEFT JOIN candidates c ON c.id=r.candidate_id
    LEFT JOIN LATERAL (SELECT status,last_error FROM analysis_tasks t WHERE t.resume_id=r.id AND t.organization_id=r.organization_id ORDER BY created_at DESC,id DESC LIMIT 1) t ON true
    LEFT JOIN LATERAL (SELECT result FROM analysis_results ar WHERE ar.resume_id=r.id AND ar.organization_id=r.organization_id ORDER BY created_at DESC,id DESC LIMIT 1) ar ON true
    ORDER BY r.organization_id,r.created_at,r.id`)
  const results = []
  for (const row of rows) {
    if (onlyIds.size && !onlyIds.has(row.id)) continue
    const item = { resumeId: row.id, organizationId: row.organization_id, candidateId: row.candidate_id, filename: row.original_filename, currentName: row.current_name, taskStatus: row.task_status, lastError: row.last_error, issues: [] }
    try {
      if (row.candidate_org !== row.organization_id) {
        item.issues.push('candidate_scope_mismatch')
        results.push(item)
        console.log(JSON.stringify({ checked: results.length, total: rows.length, resumeId: item.resumeId, issues: item.issues }))
        continue
      }
      const bytes = await storage.get(row.storage_key)
      item.sourceContentHash = createHash('sha256').update(bytes).digest('hex')
      if (item.sourceContentHash !== row.content_hash) throw new Error('SOURCE_CONTENT_HASH_MISMATCH')
      let cached
      if (cacheDirectory && !forceSourceIds.has(row.id)) {
        try { cached = await readFile(resolve(cacheDirectory, `${row.id}.txt`), 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      const text = cached ?? await extractResumeText(bytes, row.original_filename, row.mime_type)
      const parsed = parseResume({ documentId: row.id, fileName: row.original_filename, text })
      const extraction = extractResume(parsed, row.original_filename)
      await writeFile(resolve(directory, `${row.id}.extraction.json`), JSON.stringify({ parsed, extraction }, null, 2))
      const report = row.stored_result?.analysis?.report ?? row.stored_result?.report ?? row.stored_result
      const oldExtraction = report?.extraction
      item.fields = {}
      // Project records are intentionally stored in experience, not projects.
      for (const field of ['education', 'experience', 'skills']) {
        const before = oldExtraction?.[field]?.length ?? 0
        const after = extraction[field]?.length ?? 0
        item.fields[field] = { stored: before, extracted: after }
        if (after > 0 && before === 0 && row.stored_result) item.issues.push(`stored_${field}_missing`)
        if (before > after) item.issues.push(`${field}_count_decreased`)
      }
      if (!extraction.education?.length && /教育(?:背景|经历)|毕业院校|学历/u.test(text)) item.issues.push('education_requires_review')
      if (!extraction.experience?.length && /工作(?:经历|经验)|实习经历/u.test(text)) item.issues.push('experience_requires_review')
      if (!extraction.experience?.length && /项目(?:经历|经验|介绍)/u.test(text)) item.issues.push('projects_requires_review')
      Object.assign(item, { characters: text.length, extractedName: extraction.candidate.fullName, storedName: oldExtraction?.candidate?.fullName, profile: extraction.profile, head: text.slice(0, 1000) })
      if (!item.extractedName) item.issues.push('name_missing')
      if (isResumePlaceholderName(item.currentName)) item.issues.push('placeholder_name')
      if (item.extractedName && item.extractedName !== item.currentName) item.issues.push('name_mismatch')
      if (text.length < 150) item.issues.push('short_text')
      if (!row.stored_result) item.issues.push('no_analysis_result')
      if (row.task_status === 'failed') item.issues.push('latest_task_failed')
      await writeFile(resolve(directory, `${row.id}.txt`), text, 'utf8')
    } catch (error) { item.issues.push('source_extraction_failed'); item.error = error instanceof Error ? error.message : String(error) }
    results.push(item)
    console.log(JSON.stringify({ checked: results.length, total: rows.length, resumeId: item.resumeId, issues: item.issues, error: item.error }))
  }
  const counts = {}
  for (const item of results) for (const issue of item.issues) counts[issue] = (counts[issue] ?? 0) + 1
  await writeFile(resolve(directory, 'audit.json'), JSON.stringify({ extractorVersion: EXTRACTOR_VERSION, total: results.length, counts, results }, null, 2))
  console.log(JSON.stringify({ directory, total: results.length, counts }))
} finally { await pool.end() }
