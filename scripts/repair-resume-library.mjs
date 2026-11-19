import '../apps/api/dist/src/env.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createPostgresHealthPool } from '../apps/api/dist/src/recruiting/db-health.js'
import { parseResume, extractResume } from '../packages/resume-intelligence/dist/index.js'

// Only document extraction changes here; historical assessments are not rescored.
const directory = resolve(process.argv[2] ?? '')
const apply = process.argv.includes('--apply')
const audit = JSON.parse(await readFile(resolve(directory, 'audit.json'), 'utf8'))
if (audit.total !== 174) throw new Error('Expected the reviewed full-library audit')
const pool = createPostgresHealthPool()
const repairedAt = new Date().toISOString()
const output = resolve('reports', `resume-repair-${Date.now()}`)
await mkdir(output, { recursive: true })
const changes = []
const skipped = []
const jsonValue = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const same = (a, b) => isDeepStrictEqual(jsonValue(a), jsonValue(b))
const forbidden = new Set(['candidate_scope_mismatch', 'source_extraction_failed', 'name_missing', 'short_text', 'education_requires_review', 'projects_requires_review'])
try {
  for (const item of audit.results) {
    if (item.issues.some((issue) => forbidden.has(issue))) { skipped.push({ resumeId: item.resumeId, issues: item.issues }); continue }
    const source = JSON.parse(await readFile(resolve(directory, `${item.resumeId}.extraction.json`), 'utf8'))
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [row] } = await client.query(`SELECT r.*,c.name,c.name_manually_edited FROM resumes r
        JOIN candidates c ON c.id=r.candidate_id AND c.organization_id=r.organization_id
        WHERE r.id=$1 AND r.organization_id=$2 FOR UPDATE OF r,c`, [item.resumeId,item.organizationId])
      if (!row || row.content_hash !== item.sourceContentHash || row.candidate_id !== item.candidateId || row.scan_status !== 'clean') throw new Error('Resume identity/hash/scan status changed')
      const parsed = parseResume({documentId:row.id,fileName:row.original_filename,mimeType:row.mime_type,text:source.parsed.originalText})
      const extraction = extractResume(parsed,row.original_filename)
      if (!same(parsed,source.parsed) || !same(extraction,source.extraction)) throw new Error('Audited parser output changed; rerun audit')
      const { rows: results } = await client.query(`SELECT DISTINCT ON (ar.application_id) ar.* FROM analysis_results ar
        WHERE ar.resume_id=$1 AND ar.organization_id=$2
        AND (ar.application_id IS NULL OR EXISTS (SELECT 1 FROM applications a JOIN jobs j ON j.id=a.job_id AND j.organization_id=a.organization_id
          WHERE a.id=ar.application_id AND a.candidate_id=$3 AND a.organization_id=$2))
        ORDER BY ar.application_id,ar.created_at DESC,ar.id DESC`,[row.id,row.organization_id,row.candidate_id])
      await writeFile(resolve(output,`${row.id}.before.json`),JSON.stringify({resume:row,results},null,2))
      let repaired = 0
      for (const result of results) {
        const next = structuredClone(result.result)
        const report = next.analysis?.report ?? (next.extraction ? next : undefined)
        if (!report) throw new Error('Unsupported analysis result shape')
        if (same(report.extraction,extraction) && same(report.parsedResume,parsed)) continue
        const before = structuredClone(report)
        report.parsedResume = parsed
        report.extraction = extraction
        report.provenance = { ...report.provenance, documentRepair:{repairedAt,parserVersion:parsed.parserVersion,extractorVersion:extraction.extractorVersion,sourceContentHash:row.content_hash,assessmentPreserved:true} }
        if (next.document) next.document = {...next.document,textLength:parsed.originalText.length,normalizedTextLength:parsed.normalizedText.length}
        if (!same(before.assessment,report.assessment) || !same(before.humanReview,report.humanReview)
          || !same(next.scoring,result.result.scoring) || !same(next.analysis?.suggestion,result.result.analysis?.suggestion)) throw new Error('Assessment preservation failed')
        if (apply) {
          const changed = await client.query(`UPDATE analysis_results SET result=$1::jsonb WHERE id=$2 AND organization_id=$3 AND result=$4::jsonb`,[JSON.stringify(next),result.id,row.organization_id,JSON.stringify(result.result)])
          if (changed.rowCount !== 1) throw new Error('Concurrent analysis edit; repair aborted')
        }
        repaired++
      }
      let extractionOnly = false
      if (!results.length) {
        const {rows:[tasks]}=await client.query('SELECT count(*)::int AS count FROM analysis_tasks WHERE resume_id=$1 AND organization_id=$2',[row.id,row.organization_id])
        if (tasks.count || row.application_id) throw new Error('Unprocessed task/application needs normal worker processing')
        extractionOnly=true
        if(apply) {
          const taskId=randomUUID()
          await client.query(`INSERT INTO analysis_tasks(id,resume_id,status,attempts,idempotency_key,completed_at,organization_id)
            VALUES($1,$2,'completed',0,$3,now(),$4)`,[taskId,row.id,`document-repair:${row.id}:${row.content_hash}`,row.organization_id])
          const result={taskType:'resume-analysis',status:'completed',resumeId:row.id,candidateId:row.candidate_id,
            document:{fileName:row.original_filename,mimeType:row.mime_type,textLength:parsed.originalText.length,normalizedTextLength:parsed.normalizedText.length,contentSha256:row.content_hash},
            analysis:{engine:'document-extraction-only',generatedAt:repairedAt,report:{subject:{resumeId:row.id,candidateId:row.candidate_id},parsedResume:parsed,extraction,provenance:{engine:'document-extraction-only',parserVersion:parsed.parserVersion,extractorVersion:extraction.extractorVersion},generatedAt:repairedAt}}}
          await client.query(`INSERT INTO analysis_results(analysis_task_id,resume_id,result,analyzer_version,organization_id) VALUES($1,$2,$3::jsonb,$4,$5)`,[taskId,row.id,JSON.stringify(result),extraction.extractorVersion,row.organization_id])
        }
      }
      const unicodeNameRepair=!row.name_manually_edited && row.name!==extraction.candidate.fullName && row.name.normalize('NFKC').replace(/⻓/gu,'长')===extraction.candidate.fullName
      if (apply && unicodeNameRepair) await client.query(`UPDATE candidates SET name=$1,updated_at=now() WHERE id=$2 AND organization_id=$3 AND name=$4 AND NOT name_manually_edited`,[extraction.candidate.fullName,row.candidate_id,row.organization_id,row.name])
      if(apply && (repaired || extractionOnly)) await client.query('UPDATE resumes SET parser_version=$1 WHERE id=$2 AND organization_id=$3',[parsed.parserVersion,row.id,row.organization_id])
      await client.query(apply?'COMMIT':'ROLLBACK')
      changes.push({resumeId:row.id,resultCount:repaired,extractionOnly,unicodeNameRepair})
    } catch(error) { await client.query('ROLLBACK'); throw new Error(`Repair stopped at ${item.resumeId}: ${error.message}`,{cause:error}) }
    finally {client.release()}
  }
  const summary={apply,auditDirectory:directory,checked:audit.total,resumes:changes.length,results:changes.reduce((n,item)=>n+item.resultCount,0),extractionOnly:changes.filter(item=>item.extractionOnly).length,names:changes.filter(item=>item.unicodeNameRepair).length,skipped,changes}
  await writeFile(resolve(output,'repair.json'),JSON.stringify(summary,null,2))
  console.log(JSON.stringify({...summary,changes:undefined,output}))
} finally {await pool.end()}
