import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, chmod, access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { migrationPlan, validateMigrationPlan, snapshotDigest } from '../migration-approval.mjs'
import { parseMaintenanceArgs } from '../maintenance-migrations.mjs'
import { locateReference, parseAuditArgs, summarizeRecoveryDifferences } from '../runtime-recovery-audit.mjs'
import { parseRehearsalArgs, protectRecoveryDirectory, fingerprintTables, verifyTableFingerprints } from '../runtime-recovery-rehearsal.mjs'
import { verifyRecoveryPath, writePrivateRecoveryFile, preparePrivateRecoveryDirectory } from '../private-recovery-files.mjs'
import { recoveryMigrations, verifyRecoveryMigrationScope, validateMigrationCatalog } from '../recovery-snapshot.mjs'

const now = new Date('2026-11-16T06:00:00Z')
function approvedPlan() {
  const plan = migrationPlan({ identity: { database: 'synthetic', databaseOid: '123', serverAddress: '127.0.0.1', serverPort: 55432 },
    ledger: [{ version: '0001', name: '0001_first.sql' }], files: [{ name: '0001_first.sql', sha256: 'a'.repeat(64) }, { name: '0002_second.sql', sha256: 'b'.repeat(64) }], pending: ['0002_second.sql'] }, now)
  plan.approval = { reviewedBy: 'synthetic-reviewer', approvedAt: now.toISOString(), expiresAt: '2026-11-16T07:00:00Z', snapshotSha256: plan.snapshotSha256,
    evidenceReferences: Object.fromEntries(['writersDrained', 'backupRestored', 'dataReconciled', 'objectsReviewed', 'configReviewed', 'rehearsalPassed'].map(name => [name, 'synthetic-evidence-' + name])) }
  return plan
}

test('a generated migration plan is never implicitly approved', () => {
  const plan = approvedPlan(); plan.approval = null
  assert.throws(() => validateMigrationPlan(plan, now), /explicit reviewer/)
})

test('valid approval returns the exact snapshot and canonical hashes ignore property order', () => {
  const plan = approvedPlan()
  assert.equal(validateMigrationPlan(plan, now), plan.snapshot)
  assert.equal(snapshotDigest({ a: 1, b: 2 }), snapshotDigest({ b: 2, a: 1 }))
})

for (const mutation of ['digest', 'target', 'context', 'reviewer', 'expired', 'future', 'long-window', 'missing-evidence', 'empty-pending']) {
  test('approval refuses ' + mutation, () => {
    const plan = approvedPlan()
    if (mutation === 'digest') plan.snapshotSha256 = '0'.repeat(64)
    if (mutation === 'target') plan.snapshot.identity.database = 'another'
    if (mutation === 'context') plan.context = { release: 'another' }
    if (mutation === 'reviewer') plan.approval.reviewedBy = ''
    if (mutation === 'expired') plan.approval.expiresAt = now.toISOString()
    if (mutation === 'future') plan.approval.approvedAt = '2026-11-16T06:30:00Z'
    if (mutation === 'long-window') plan.approval.expiresAt = '2026-11-16T11:00:00Z'
    if (mutation === 'missing-evidence') delete plan.approval.evidenceReferences.backupRestored
    if (mutation === 'empty-pending') plan.snapshot.pending = []
    assert.throws(() => validateMigrationPlan(plan, now), /MIGRATION_APPROVAL_REQUIRED/)
  })
}

test('maintenance options reject unknown, duplicate and relative paths before connecting', () => {
  const profile = resolve('synthetic.env'), plan = resolve('synthetic.json')
  assert.equal(parseMaintenanceArgs(['plan', '--profile', profile, '--plan', plan]).action, 'plan')
  for (const args of [['apply', '--profile', profile, '--plan', plan], ['plan', '--profile', 'relative.env', '--plan', plan],
    ['plan', '--profile', profile, '--plan', plan, '--plan', plan], ['plan', '--unknown', 'value'], ['plan', '--profile']])
    assert.throws(() => parseMaintenanceArgs(args))
})

test('object inspection locates ordinary files and never treats traversal or absent files as recovered', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recovery-objects-'))
  try {
    await mkdir(join(directory, 'nested')); await writeFile(join(directory, 'nested', 'object.bin'), 'fixture')
    assert.equal((await locateReference('nested/object.bin', [directory])).state, 'found')
    assert.equal((await locateReference('missing.bin', [directory])).state, 'not-found-in-checked-roots')
    assert.equal((await locateReference('unreviewed.bin', [])).state, 'roots-not-reviewed')
    assert.equal((await locateReference('../escape', [directory])).state, 'invalid-key')
    assert.equal((await locateReference('..' + String.fromCharCode(92) + 'escape', [directory])).state, 'invalid-key')
    assert.equal((await locateReference(String.fromCharCode(0), [directory])).state, 'invalid-key')
    assert.equal((await locateReference(directory, [directory])).state, 'invalid-key')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('audit options require explicit absolute paths and do not accept silent fallback options', () => {
  const path = resolve('audit.json')
  assert.equal(parseAuditArgs(['--output', path]).output, path)
  for (const args of [[], ['--output', 'relative.json'], ['--output', path, '--output', path], ['--bad', path]])
    assert.throws(() => parseAuditArgs(args))
})

test('real snapshot rehearsal requires explicit source, tools and new output paths', () => {
  const args = ['--profile', resolve('profile.env'), '--postgres-bin', resolve('pgsql'), '--output-dir', resolve('new-backup'), '--expect-target', '127.0.0.1:5432/expected']
  assert.equal(parseRehearsalArgs(args).profile, resolve('profile.env'))
  for (const invalid of [[], args.slice(0, -2), [...args, '--drop-source', 'yes'], [...args, '--profile', resolve('other.env')], ['--profile', 'relative.env', ...args.slice(2)]])
    assert.throws(() => parseRehearsalArgs(invalid), /REHEARSAL_ARGS/)
})

test('fingerprint comparison fails on changed, missing and extra tables; only the explicit ledger exception is allowed', () => {
  const rows = [{ schema: 'public', name: 'schema_migrations', rows: '100', sha256: 'first' }, { schema: 'company_test', name: 'resumes', rows: '1', sha256: 'business' }]
  verifyTableFingerprints(rows, structuredClone(rows))
  const upgraded = structuredClone(rows); upgraded[0].sha256 = 'upgraded'
  assert.throws(() => verifyTableFingerprints(rows, upgraded), /REHEARSAL_DATA_MISMATCH/)
  verifyTableFingerprints(rows, upgraded, { excludeLedger: true })
  for (const changed of [rows.slice(0, 1), [...rows, { schema: 'public', name: 'unexpected' }], [rows[0], { ...rows[1], sha256: 'changed' }]])
    assert.throws(() => verifyTableFingerprints(rows, changed, { excludeLedger: true }), /REHEARSAL_DATA_MISMATCH/)
})

test('fingerprinting quotes identifiers and obtains only aggregate hashes, not business row bodies', async () => {
  const queries = []
  const client = { async query(sql) { queries.push(sql); return { rows: queries.length === 1 ? [{ schema: 'company_test', name: 'quoted"table', kind: 'r' }] : [{ rows: '2', sha256: 'a'.repeat(64) }] } } }
  const result = await fingerprintTables(client)
  assert.equal(result[0].rows, '2')
  assert.match(queries[1], /"company_test"\."quoted""table"/)
  assert.match(queries[1], /string_agg\(digest,'' ORDER BY digest\)/)
})

test('private recovery directory permissions are established before business bytes can be written', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recovery-private-'))
  try { await protectRecoveryDirectory(directory); await writeFile(join(directory, 'synthetic.txt'), 'synthetic') }
  finally { await rm(directory, { recursive: true, force: true }) }
})

test('0101-0104 rehearsal refuses a subset, additional migration or changed SQL bytes', () => {
  const approval = { pending: recoveryMigrations.map(file => file.name), files: structuredClone(recoveryMigrations) }
  verifyRecoveryMigrationScope(approval)
  for (const change of ['subset', 'extra', 'bytes', 'order']) {
    const altered = structuredClone(approval)
    if (change === 'subset') altered.pending.pop()
    if (change === 'extra') altered.pending.push('0105_unreviewed.sql')
    if (change === 'bytes') altered.files[2].sha256 = '0'.repeat(64)
    if (change === 'order') altered.pending.reverse()
    assert.throws(() => verifyRecoveryMigrationScope(altered), /REHEARSAL_MIGRATION/)
  }
})

test('restore verification permits an already migrated snapshot only when explicitly enabled', () => {
  const approval = { pending: [], files: structuredClone(recoveryMigrations) }
  assert.throws(() => verifyRecoveryMigrationScope(approval), /REHEARSAL_MIGRATION/)
  verifyRecoveryMigrationScope(approval, { allowAlreadyApplied: true })
  assert.throws(() => verifyRecoveryMigrationScope({ ...approval, pending: ['0107_unreviewed.sql'] }, { allowAlreadyApplied: true }), /REHEARSAL_MIGRATION/)
})

function catalogFixture() {
  const companies = [{ schema_name: 'company_test', organization_id: 'synthetic' }]
  const column = { name: 'id', type: 'uuid', notNull: true, identity: '', generated: '', default: null }
  const before = ['public', 'company_test', 'unregistered'].flatMap(schema => [
    { schema, name: 'interview_live_sessions', kind: 'r', columns: [column] },
    { schema, name: 'jobs', kind: 'r', columns: [column] },
  ])
  const roleColumn = { name: 'manual_transcript_roles', type: 'jsonb', notNull: true, identity: '', generated: '', default: "'[]'::jsonb" }
  const after = structuredClone(before)
  for (const table of after) if (table.name === 'interview_live_sessions' && table.schema !== 'unregistered') table.columns.push(roleColumn)
  for (const name of ['company_data_cutovers', 'maintenance_receipts']) after.push({ schema: 'recovery_control', name, kind: 'r', columns: [] })
  return { before, after, companies }
}

test('migration catalog permits exactly the new role column on public and registered company interview tables', () => {
  const { before, after, companies } = catalogFixture()
  assert.deepEqual(validateMigrationCatalog(before, after, companies), ['public', 'company_test'])
})

for (const change of ['missing-table', 'extra-table', 'changed-kind', 'changed-old-column', 'wrong-default', 'nullable-role-column', 'unregistered-column', 'extra-column', 'missing-role-column', 'preexisting-control-table']) {
  test('migration catalog refuses ' + change, () => {
    const { before, after, companies } = catalogFixture()
    if (change === 'missing-table') after.splice(1, 1)
    if (change === 'extra-table') after.push({ schema: 'public', name: 'unexpected', kind: 'r', columns: [] })
    if (change === 'changed-kind') after[0].kind = 'm'
    if (change === 'changed-old-column') after[1].columns[0].type = 'text'
    if (change === 'wrong-default') after[0].columns[1] = { ...after[0].columns[1], default: "'[{}]'::jsonb" }
    if (change === 'nullable-role-column') after[0].columns[1] = { ...after[0].columns[1], notNull: false }
    if (change === 'unregistered-column') after[4].columns.push(after[0].columns[1])
    if (change === 'extra-column') after[1].columns.push({ name: 'unreviewed', type: 'text' })
    if (change === 'missing-role-column') after[0].columns.pop()
    if (change === 'preexisting-control-table') before.push(after.at(-1))
    assert.throws(() => validateMigrationCatalog(before, after, companies), /REHEARSAL_SCHEMA_MISMATCH/)
  })
}

test('migration fingerprint projects only the reviewed new column, retaining all legacy values in the digest', async () => {
  const queries = []
  const client = { async query(sql) { queries.push(sql); return { rows: queries.length === 1 ? [
    { schema: 'public', name: 'interview_live_sessions', kind: 'r' },
    { schema: 'unregistered', name: 'interview_live_sessions', kind: 'r' },
    { schema: 'public', name: 'jobs', kind: 'r' },
  ] : [{ rows: '1', sha256: 'a'.repeat(64) }] } } }
  await fingerprintTables(client, { omitRoleReviewSchemas: ['public'] })
  assert.match(queries[1], /to_jsonb\(t\)-'manual_transcript_roles'/)
  assert.doesNotMatch(queries[2], /manual_transcript_roles/)
  assert.doesNotMatch(queries[3], /manual_transcript_roles/)
})

test('difference summary distinguishes table groups from row counts and non-row blockers', () => {
  const companyData = { companies: [{ differences: [{ entries: [{}, {}] }, { code: 'STRUCTURE_MISMATCH' }] }, { differences: [{ entries: [{}] }] }] }
  assert.deepEqual(summarizeRecoveryDifferences(companyData, [{ kind: 'conflict' }, { kind: 'company-only' }, { kind: 'legacy-only' }]),
    { tableGroups: 2, rowDifferences: 3, byKind: { conflict: 1, 'company-only': 1, 'legacy-only': 1 }, nonRowBlockers: 1 })
})

test('private evidence files are verified independently, not overwritten and need no PowerShell security module', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'recovery-private-files-')), directory = join(parent, 'private')
  const oldModulePath = process.env.PSModulePath
  try {
    process.env.PSModulePath = join(parent, 'no-powershell-modules')
    await preparePrivateRecoveryDirectory(directory)
    await preparePrivateRecoveryDirectory(directory)
    const file = join(directory, 'evidence.json')
    await writePrivateRecoveryFile(file, '{}')
    await verifyRecoveryPath(file)
    await assert.rejects(writePrivateRecoveryFile(file, 'replacement'), { code: 'EEXIST' })
  } finally {
    if (oldModulePath === undefined) delete process.env.PSModulePath
    else process.env.PSModulePath = oldModulePath
    await rm(parent, { recursive: true, force: true })
  }
})

test('unsafe existing directory fails closed before writing; explicit foreign grants cannot pass protection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recovery-unsafe-'))
  try {
    await protectRecoveryDirectory(directory)
    if (process.platform === 'win32') await promisify(execFile)('icacls.exe', [directory, '/grant', '*S-1-1-0:R'], { windowsHide: true })
    else await chmod(directory, 0o755)
    await assert.rejects(verifyRecoveryPath(directory), /RECOVERY_ACL_UNSAFE/)
    await assert.rejects(preparePrivateRecoveryDirectory(directory), /RECOVERY_ACL_UNSAFE/)
    await assert.rejects(writePrivateRecoveryFile(join(directory, 'must-not-exist'), 'synthetic'), /RECOVERY_ACL_UNSAFE/)
    await assert.rejects(access(join(directory, 'must-not-exist')), { code: 'ENOENT' })
    if (process.platform === 'win32') await assert.rejects(protectRecoveryDirectory(directory), /RECOVERY_ACL_UNSAFE/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
