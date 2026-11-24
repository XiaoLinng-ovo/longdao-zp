import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startIsolatedPostgres } from './isolated-environment.mjs'
import { protectRecoveryPath, writePrivateRecoveryFile } from './private-recovery-files.mjs'
import { fingerprintTables, verifyTableFingerprints } from './recovery-snapshot.mjs'
const directory = resolve(process.argv[2]), root = resolve(import.meta.dirname, '..')
const report = { format: 'database-owner-acl-restore/v1', startedAt: new Date().toISOString(), passed: false, sourceDatabaseWritten: false }
const resumed = process.argv[3] === '--resumed'
assert.ok(process.argv[3] === undefined || resumed, 'Unknown restore option')
const output = join(directory, resumed ? 'resumed-owner-acl-restore-' + Date.now() + '.json' : 'owner-acl-restore-report.json')
const backup = JSON.parse(await readFile(join(directory, resumed ? 'resumed-frozen-backup-report.json' : 'frozen-backup-report.json')))
assert.equal(backup.passed, true)
const instance = await startIsolatedPostgres('D:/software/pgsql/bin', { directoryParent: directory })
await protectRecoveryPath(instance.directory)
const { Pool } = createRequire(join(root, 'apps/api/package.json'))('pg')
const admin = new Pool(instance.connection), execute = promisify(execFile)
let clone
try {
  await execute('D:/software/pgsql/bin/psql.exe', ['--no-password', '--dbname=postgres', '--set=ON_ERROR_STOP=1', '--file=' + (backup.rolesDump || join(directory, 'roles-without-passwords.sql'))], { env: instance.env, windowsHide: true, timeout: 60000 })
  await admin.query('CREATE DATABASE restored_business OWNER smartrecruit')
  await execute('D:/software/pgsql/bin/pg_restore.exe', ['--no-password', '--exit-on-error', '--single-transaction', '--dbname=restored_business', backup.dump], { env: { ...instance.env, PGOPTIONS: '-c timezone=UTC' }, windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024 })
  clone = new Pool({ ...instance.connection, database: 'restored_business', options: '-c timezone=UTC' })
  const original = JSON.parse(await readFile(join(backup.databaseRehearsalDirectory || join(directory, 'database-rehearsal'), 'table-fingerprints.json')))
  verifyTableFingerprints(original, await fingerprintTables(clone))
  report.snapshotRestoreVerified = true
  const ownership = (await clone.query("SELECT n.nspname AS schema,c.relname AS name,c.relkind,pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','S','v','m') ORDER BY n.nspname,c.relname")).rows
  const canonicalOwnership = async entries => (await clone.query(`
    SELECT e.schema,e.name,e.relkind,e.owner,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'grantor',pg_get_userbyid(a.grantor),
        'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        'privilege',a.privilege_type,'grantable',a.is_grantable)
        ORDER BY pg_get_userbyid(a.grantor),a.grantee=0,pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable)
        FROM aclexplode(COALESCE(e.acl::aclitem[],acldefault(
          CASE WHEN e.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,r.oid))) a),'[]'::jsonb) AS privileges
    FROM jsonb_to_recordset($1::jsonb) AS e(schema text,name text,relkind text,owner text,acl text)
    LEFT JOIN pg_roles r ON r.rolname=e.owner
    ORDER BY e.schema COLLATE "C",e.name COLLATE "C"
  `, [JSON.stringify(entries)])).rows
  const expectedOwnership = await canonicalOwnership(backup.ownership)
  const restoredOwnership = await canonicalOwnership(ownership)
  report.ownerAclObjects = ownership.length; report.tablesVerified = original.length
  report.aclComparison = 'PostgreSQL-parsed effective grants, grantors, grant options and exact owners'
  if (JSON.stringify(restoredOwnership) !== JSON.stringify(expectedOwnership)) {
    const expected = new Map(expectedOwnership.map(entry => [entry.schema + '.' + entry.name, entry]))
    report.ownershipDifferences = restoredOwnership.filter(entry => JSON.stringify(entry) !== JSON.stringify(expected.get(entry.schema + '.' + entry.name))).map(entry => ({ restored: entry, expected: expected.get(entry.schema + '.' + entry.name) }))
  }
  assert.deepEqual(restoredOwnership, expectedOwnership)
  report.passed = true; report.ownerAclObjects = ownership.length; report.tablesVerified = original.length
  report.originalOwnershipAndAclsRestored = true
  report.limitations = ['Roles restored without password verifiers; administrator credentials remain externally held. Database-level connection ACLs and operating-system service registration are outside this test.']
} catch (error) { report.failure = { code: typeof error.code === 'string' ? error.code : 'OWNER_ACL_RESTORE_FAILED' }; process.exitCode = 1 }
finally {
  await clone?.end(); await admin.end(); await instance.stop()
  report.isolatedPostgresStopped = true; report.finishedAt = new Date().toISOString()
  await writePrivateRecoveryFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, snapshotRestoreVerified: report.snapshotRestoreVerified, tablesVerified: report.tablesVerified, ownerAclObjects: report.ownerAclObjects, differences: report.ownershipDifferences?.length, failure: report.failure, report: output }))
}
