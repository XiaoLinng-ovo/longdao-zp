import { createHash } from 'node:crypto'

export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  return JSON.stringify(value)
}

export const snapshotDigest = value => createHash('sha256').update(canonicalJson(value)).digest('hex')

export function migrationPlan(snapshot, now = new Date(), context = null) {
  return { format: 'migration-approval/v1', createdAt: now.toISOString(), snapshot,
    context, snapshotSha256: snapshotDigest({ snapshot, context }), approval: null,
    instructions: 'No authorization implied. After independent review, set approval: reviewedBy, approvedAt, expiresAt, snapshotSha256 and evidenceReferences (writersDrained, backupRestored, dataReconciled, objectsReviewed, configReviewed, rehearsalPassed). References are operator attestations, not automatically verified backup proof.' }
}

export function validateMigrationPlan(plan, now = new Date()) {
  const invalid = message => { throw new Error('MIGRATION_APPROVAL_REQUIRED: ' + message) }
  if (plan?.format !== 'migration-approval/v1' || !plan.snapshot || plan.snapshotSha256 !== snapshotDigest({ snapshot: plan.snapshot, context: plan.context }))
    invalid('The plan is invalid or its snapshot digest changed.')
  const { identity, files, ledger, pending } = plan.snapshot
  if (!identity || typeof identity.database !== 'string' || !identity.database || !/^\d+$/.test(identity.databaseOid) ||
    typeof identity.serverAddress !== 'string' || !identity.serverAddress || !Number.isInteger(identity.serverPort) || identity.serverPort < 1 || identity.serverPort > 65535)
    invalid('The database identity is incomplete.')
  if (!Array.isArray(files) || !files.length || files.some(file => !/^\d+_[a-z0-9][a-z0-9_-]*\.sql$/i.test(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256)) ||
    new Set(files.map(file => file.name)).size !== files.length || !Array.isArray(ledger) || !ledger.length ||
    !Array.isArray(pending) || !pending.length || pending.some(name => !files.some(file => file.name === name)) || new Set(pending).size !== pending.length)
    invalid('The migration inventory or baseline is incomplete.')
  const approval = plan.approval
  if (!approval || typeof approval.reviewedBy !== 'string' || !approval.reviewedBy.trim() || approval.snapshotSha256 !== plan.snapshotSha256)
    invalid('An explicit reviewer and approval of this exact digest are required.')
  const created = Date.parse(plan.createdAt), start = Date.parse(approval.approvedAt), end = Date.parse(approval.expiresAt), time = now.getTime()
  if (![created, start, end, time].every(Number.isFinite) || created > start || start > time || end <= time || end <= start || end - start > 4 * 60 * 60 * 1000)
    invalid('Approval must be valid now and limited to a maintenance window of at most four hours.')
  for (const name of ['writersDrained', 'backupRestored', 'dataReconciled', 'objectsReviewed', 'configReviewed', 'rehearsalPassed']) {
    if (typeof approval.evidenceReferences?.[name] !== 'string' || approval.evidenceReferences[name].trim().length < 5)
      invalid('Missing independently reviewed maintenance evidence reference: ' + name)
  }
  return plan.snapshot
}
