import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { testCodeFingerprint } from './test-code-fingerprint.mjs'
import { assertReleaseReady } from '../packages/database-readiness/index.js'
import { captureStructure } from '../packages/database-readiness/structure-contract.js'

const argument = process.argv.indexOf('--postgres-bin')
assert.ok(argument >= 0 && process.argv[argument + 1], '必须显式指定专用 PostgreSQL 工具目录')
const fingerprint = await testCodeFingerprint(projectRoot)
const instance = await startIsolatedPostgres(process.argv[argument + 1])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env)
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
const { Pool } = require('pg'), admin = new Pool(instance.connection)
const report = { startedAt: new Date().toISOString(), boundary: '专用随机集群；真实历史迁移和结构破坏；不接触业务库',
  checks: [], failures: [], cleanup: {}, codeFingerprint: fingerprint.sha256 }
let pool, created = false
const options = { migrationsDirectory: join(projectRoot, 'db/migrations'), tenantRouting: true,
  storageLocations: { resume: 'a'.repeat(64), interview: 'a'.repeat(64) } }
const quote = value => '"' + value.replaceAll('"', '""') + '"'
async function check(name, action) {
  console.log('验证：' + name)
  const item = { name, startedAt: new Date().toISOString() }; report.checks.push(item)
  try { item.result = await action(); item.passed = true }
  catch (error) { item.passed = false; throw error }
  finally { item.finishedAt = new Date().toISOString() }
}
async function ready() { return assertReleaseReady(pool, options) }
async function damage(name, sql, restore, pattern = /结构契约/) {
  await check(name, async () => {
    await pool.query(sql)
    try { await assert.rejects(ready(), pattern) }
    finally { await pool.query(restore) }
    await ready()
    return { rejected: true, restored: true }
  })
}
async function company() {
  const id = randomUUID()
  await pool.query("INSERT INTO public.organizations(id,name,kind,service_status) VALUES($1,'同名结构验收公司','test','enabled')", [id])
  return { id, schema: (await pool.query('SELECT public.initialize_organization_schema($1) AS schema', [id])).rows[0].schema }
}
try {
  await admin.query('CREATE DATABASE ' + quote(instance.database)); created = true
  pool = new Pool({ ...instance.connection, database: instance.database })
  const { runMigrations } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/db/migrations.js')))
  const partial = join(instance.directory, 'migrations-through-74')
  await mkdir(partial)
  const names = (await readdir(options.migrationsDirectory)).filter(name => name.endsWith('.sql')).sort()
  for (const name of names.filter(name => name < '0075_')) await copyFile(join(options.migrationsDirectory, name), join(partial, name))
  let old, current
  await check('真实0074历史公司升级后与新公司结构契约兼容', async () => {
    await runMigrations(pool, partial)
    await pool.query(`ALTER TABLE public.platform_operators DROP CONSTRAINT platform_operators_role_check,
      ADD CONSTRAINT platform_operators_role_check CHECK (role IN ('super_admin', 'admin', 'viewer'))`)
    await pool.query(`INSERT INTO public.recruiting_state(id,state) VALUES ('legacy-fixture','{"keep":true}'::jsonb)`)
    old = await company()
    const resultMigrations = await runMigrations(pool, options.migrationsDirectory)
    assert.ok(resultMigrations.alreadyApplied.includes('0006_recruiting_state_bridge.sql'))
    assert.ok(resultMigrations.applied.includes('0102_platform_operator_role_constraint.sql'))
    assert.deepEqual((await pool.query(`SELECT state FROM public.recruiting_state WHERE id='legacy-fixture'`)).rows, [{ state: { keep: true } }])
    current = await company()
    const result = await ready()
    return { ...result, historicalCompany: old.id, newCompany: current.id, server: (await pool.query('SHOW server_version')).rows[0].server_version }
  })
  await check('门禁只读且重复执行不修改结构或迁移账本', async () => {
    const before = await captureStructure(pool, ['public', old.schema, current.schema])
    const ledger = (await pool.query('SELECT * FROM public.schema_migrations ORDER BY version')).rows
    await ready(); await ready()
    assert.deepEqual(await captureStructure(pool, ['public', old.schema, current.schema]), before)
    assert.deepEqual((await pool.query('SELECT * FROM public.schema_migrations ORDER BY version')).rows, ledger)
    return { readOnly: true }
  })
  for (const schema of ['public', old.schema, current.schema]) {
    const relation = quote(schema) + '.analysis_tasks'
    const foreignKey = (await pool.query(`SELECT x.conname,pg_get_constraintdef(x.oid) AS definition FROM pg_constraint x
      WHERE x.conrelid=$1::regclass AND x.contype='f' AND pg_get_constraintdef(x.oid) LIKE 'FOREIGN KEY (resume_id)%'`, [relation])).rows[0]
    assert.ok(foreignKey)
    await damage(schema + '删除简历关联外键必须拒绝', 'ALTER TABLE ' + relation + ' DROP CONSTRAINT ' + quote(foreignKey.conname),
      'ALTER TABLE ' + relation + ' ADD CONSTRAINT ' + quote(foreignKey.conname) + ' ' + foreignKey.definition)
    const candidates = quote(schema) + '.candidates'
    const unique = (await pool.query(`SELECT x.conname,pg_get_constraintdef(x.oid) AS definition FROM pg_constraint x
      WHERE x.conrelid=$1::regclass AND x.contype='u' ORDER BY x.conname LIMIT 1`, [candidates])).rows[0]
    assert.ok(unique)
    await damage(schema + '删除人员唯一约束必须拒绝', 'ALTER TABLE ' + candidates + ' DROP CONSTRAINT ' + quote(unique.conname),
      'ALTER TABLE ' + candidates + ' ADD CONSTRAINT ' + quote(unique.conname) + ' ' + unique.definition)
    const resumes = quote(schema) + '.resumes'
    const trigger = (await pool.query(`SELECT t.tgname FROM pg_trigger t WHERE t.tgrelid=$1::regclass AND NOT t.tgisinternal
      AND t.tgfoid='public.guard_object_reference()'::regprocedure`, [resumes])).rows[0]
    assert.ok(trigger)
    await damage(schema + '禁用对象归属保护触发器必须拒绝', 'ALTER TABLE ' + resumes + ' DISABLE TRIGGER ' + quote(trigger.tgname),
      'ALTER TABLE ' + resumes + ' ENABLE TRIGGER ' + quote(trigger.tgname))
    const index = (await pool.query(`SELECT i.indexrelid::regclass::text AS name,pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i WHERE i.indrelid=$1::regclass AND NOT i.indisunique ORDER BY i.indexrelid LIMIT 1`, [candidates])).rows[0]
    assert.ok(index)
    await damage(schema + '删除查询索引必须拒绝', 'DROP INDEX ' + index.name, index.definition)
    const indexOid = (await pool.query('SELECT indexrelid FROM pg_index WHERE indrelid=$1::regclass ORDER BY indexrelid LIMIT 1', [candidates])).rows[0].indexrelid
    await damage(schema + '同名但无效索引必须拒绝', 'UPDATE pg_catalog.pg_index SET indisvalid=false WHERE indexrelid=' + indexOid,
      'UPDATE pg_catalog.pg_index SET indisvalid=true WHERE indexrelid=' + indexOid)
  }
  const originalFunction = (await pool.query("SELECT pg_get_functiondef('public.guard_object_reference()'::regprocedure) AS definition")).rows[0].definition
  await damage('同名对象归属函数被改为空实现必须拒绝', 'CREATE OR REPLACE FUNCTION public.guard_object_reference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$', originalFunction)
  const checker = (await pool.query("SELECT pg_get_functiondef('public.organization_schema_structure_ready(uuid)'::regprocedure) AS definition")).rows[0].definition
  await damage('同名公司结构函数伪造true也必须拒绝', 'CREATE OR REPLACE FUNCTION public.organization_schema_structure_ready(p_organization_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$', checker)
  await damage('租户默认归属被替换为其他公司必须拒绝', 'ALTER TABLE ' + quote(current.schema) + '.candidates ALTER COLUMN organization_id SET DEFAULT ' + "'" + old.id + "'::uuid",
    'ALTER TABLE ' + quote(current.schema) + '.candidates ALTER COLUMN organization_id SET DEFAULT ' + "'" + current.id + "'::uuid")
  await damage('未登记额外结构必须拒绝', 'CREATE TABLE public.synthetic_untracked(id int)', 'DROP TABLE public.synthetic_untracked')
  report.passed = true
} catch (error) {
  report.passed = false; process.exitCode = 1
  report.failures.push({ name: error.name, message: error.message, stack: error.stack })
  console.error('结构契约验收失败：' + error.message)
} finally {
  const clean = async (name, action) => { try { await action(); report.cleanup[name] = true } catch (error) { report.passed = false; process.exitCode = 1; report.failures.push({ cleanup: name, message: error.message }) } }
  await clean('poolClosed', () => pool?.end())
  if (created) await clean('databaseDropped', () => admin.query('DROP DATABASE ' + quote(instance.database) + ' WITH (FORCE)'))
  await clean('adminClosed', () => admin.end())
  await clean('postgresStopped', () => instance.stop())
  await clean('codeUnchanged', async () => assert.equal((await testCodeFingerprint(projectRoot)).sha256, fingerprint.sha256))
  report.finishedAt = new Date().toISOString()
  const output = join(instance.directory, 'schema-contract-report.json')
  await writeFile(output, JSON.stringify(report, null, 2)); console.log('报告：' + output)
}
