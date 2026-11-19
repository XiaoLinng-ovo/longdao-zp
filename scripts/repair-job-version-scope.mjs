// Repair omitted parent organization_id without exposing or reassigning real tenant data.
// Inspect one job: node scripts/repair-job-version-scope.mjs <job UUID>
// Inspect all: node scripts/repair-job-version-scope.mjs --all [--include-test-fixtures]
// Add --apply only after reviewing the plan. All changes and audits are one transaction.
import '../apps/api/dist/src/env.js'
import { createHash, randomUUID } from 'node:crypto'
import { createPostgresHealthPool } from '../apps/api/dist/src/recruiting/db-health.js'
const args = process.argv.slice(2)
const target = args[0]
const all = target === '--all'
const apply = args.includes('--apply')
const includeFixtures = args.includes('--include-test-fixtures')
if ((!all && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target ?? '')) || args.slice(1).some(arg => !['--apply', '--include-test-fixtures'].includes(arg)) || (includeFixtures && !all)) {
  throw new Error('Usage: node scripts/repair-job-version-scope.mjs <job UUID>|--all [--include-test-fixtures] [--apply]')
}
const legacy = '00000000-0000-4000-8000-000000000028'
const hash = content => createHash('sha256').update(JSON.stringify(content)).digest('hex')
const timestamp = value => value ? new Date(value).toISOString() : null
const pool = createPostgresHealthPool(), client = await pool.connect()
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const jobs = (await client.query(`SELECT j.id, j.job_no, j.title, j.organization_id, j.created_by, j.created_at, o.name AS organization_name, o.kind AS organization_kind
    FROM jobs j JOIN organizations o ON o.id = j.organization_id
    WHERE ${all ? '(EXISTS (SELECT 1 FROM job_spec_versions v WHERE v.job_id=j.id AND v.organization_id IS DISTINCT FROM j.organization_id) OR EXISTS (SELECT 1 FROM job_description_versions v WHERE v.job_id=j.id AND v.organization_id IS DISTINCT FROM j.organization_id))' : 'j.id = $1::uuid'}
    ORDER BY j.id${apply ? ' FOR UPDATE OF j' : ''}`, all ? [] : [target])).rows
  if (!all && !jobs.length) throw new Error('Job not found; no data changed')
  const changes = [], plans = []
  for (const job of jobs) {
    if (job.organization_id === legacy) throw new Error('Cannot prove the parent job enterprise; no data changed')
    const member = job.created_by && (await client.query('SELECT 1 FROM organization_members WHERE organization_id=$1 AND user_id=$2', [job.organization_id, job.created_by])).rowCount
    let ownershipEvidence = 'parent enterprise, matching creator, membership and creation time'
    if (!member) {
      // Known abandoned fixtures have no human owner. Verify their full synthetic signature;
      // a missing creator alone is never sufficient to reassign a production version.
      if (!includeFixtures || job.created_by !== null || job.organization_name !== 'resume-score-integration-test' || job.organization_kind !== 'test' || job.job_no !== 'JOB-' + job.id || job.title !== '算法工程师') throw new Error('Cannot prove ownership for job ' + job.id + '; no data changed')
      const signature = (await client.query(`SELECT
        NOT EXISTS (SELECT 1 FROM organization_members WHERE organization_id=$1) AND
        NOT EXISTS (SELECT 1 FROM applications WHERE organization_id=$1) AND
        NOT EXISTS (SELECT 1 FROM analysis_tasks WHERE organization_id=$1) AND
        NOT EXISTS (SELECT 1 FROM resumes WHERE organization_id=$1) AND
        NOT EXISTS (SELECT 1 FROM workflow_events e WHERE e.organization_id=$1 AND NOT (e.subject_type='candidate' AND e.event_type='profile_parsed' AND e.actor_user_id IS NULL AND EXISTS (SELECT 1 FROM candidates c WHERE c.id=e.subject_id AND c.organization_id=$1 AND c.name='评分联调候选人'))) AND
        (SELECT count(*) FROM jobs WHERE organization_id=$1)=1 AND
        (SELECT count(*) FROM candidates WHERE organization_id=$1)=1 AND
        EXISTS (SELECT 1 FROM candidates WHERE organization_id=$1 AND name='评分联调候选人') AS verified`, [job.organization_id])).rows[0]
      if (!signature?.verified) throw new Error('Synthetic fixture signature is not verified for ' + job.id + '; no data changed')
      ownershipEvidence = 'verified abandoned resume-scoring integration fixture; no members, applications, resumes or tasks; only synthetic profile_parsed workflow events'
    }
    const jobChanges = []
    for (const table of ['job_spec_versions', 'job_description_versions']) {
      const versions = (await client.query(`SELECT id, organization_id, created_by, created_at, version, content, confirmed_at FROM ${table} WHERE job_id=$1 AND organization_id IS DISTINCT FROM $2${apply ? ' FOR UPDATE' : ''}`, [job.id, job.organization_id])).rows
      for (const version of versions) {
        if (version.organization_id !== legacy || version.created_by !== job.created_by || new Date(version.created_at) < new Date(job.created_at) || (!member && version.confirmed_at !== null)) {
          throw new Error('Version ownership is ambiguous or belongs to a real enterprise: ' + version.id + '; transaction rolled back')
        }
        jobChanges.push({ table, id: version.id, version: version.version, beforeOrganizationId: version.organization_id, afterOrganizationId: job.organization_id, contentSha256: hash(version.content), confirmedAt: timestamp(version.confirmed_at) })
      }
    }
    plans.push({ jobId: job.id, title: job.title, organizationId: job.organization_id, organizationName: job.organization_name, ownershipEvidence, changes: jobChanges })
    changes.push(...jobChanges)
  }
  const requestId = 'job-version-scope-repair-' + randomUUID()
  if (apply) {
    for (const plan of plans) {
      for (const change of plan.changes) {
        const updated = await client.query(`UPDATE ${change.table} SET organization_id=$1 WHERE id=$2 AND job_id=$3 AND organization_id=$4 RETURNING content, confirmed_at`, [plan.organizationId, change.id, plan.jobId, legacy])
        if (updated.rowCount !== 1 || hash(updated.rows[0].content) !== change.contentSha256 || timestamp(updated.rows[0].confirmed_at) !== change.confirmedAt) throw new Error('Repair verification failed; transaction rolled back')
      }
      if (plan.changes.length) await client.query("INSERT INTO audit_logs (organization_id, action, resource_type, resource_id, request_id, metadata) VALUES ($1, 'repair_job_version_organization', 'job', $2, $3, $4::jsonb)", [plan.organizationId, plan.jobId, requestId, JSON.stringify({ reason: 'job version inserts omitted parent organization_id', ownershipEvidence: plan.ownershipEvidence, changes: plan.changes })])
    }
  }
  await client.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', ...(all ? { scope: 'all' } : { jobId: target }), repairedJobs: plans.filter(p => p.changes.length).length, repairedVersions: changes.length, plans, ...(apply && changes.length ? { requestId } : {}) }, null, 2))
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  throw error
} finally { client.release(); await pool.end() }
