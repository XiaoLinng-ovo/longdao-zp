import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { testCodeFingerprint } from './test-code-fingerprint.mjs'

const argument = process.argv.indexOf('--postgres-bin')
assert.ok(argument >= 0 && process.argv[argument + 1], '必须显式指定专用 PostgreSQL 工具目录')
const fingerprint = await testCodeFingerprint(projectRoot)
const instance = await startIsolatedPostgres(process.argv[argument + 1])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env)
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
const { Pool } = require('pg')
const { runMigrations, inspectMigrations, inspectMigrationApproval } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/db/migrations.js')))
const admin = new Pool(instance.connection)
const report = { startedAt: new Date().toISOString(), checks: [], cleanup: {}, failures: [], codeFingerprint: fingerprint.sha256,
  boundary: '随机专用本机PG、合成旧库与故障注入；不读取业务环境、不执行业务库迁移' }
const output = join(instance.directory, 'migration-atomicity-report.json')
const databases = new Set(), pools = new Set()
async function check(name, action) {
  console.log('验证：' + name)
  const item = { name, startedAt: new Date().toISOString() }; report.checks.push(item)
  try { item.result = await action(); item.passed = true }
  catch (error) { item.passed = false; throw error }
  finally { item.finishedAt = new Date().toISOString() }
}
async function database() {
  const name = 'closure_verify_' + randomUUID().replaceAll('-', '')
  assert.match(name, /^closure_verify_[a-f0-9]{32}$/)
  await admin.query('CREATE DATABASE "' + name + '"'); databases.add(name)
  const pool = new Pool({ ...instance.connection, database: name }); pools.add(pool)
  return pool
}
async function structure(pool) {
  return {
    relations: (await pool.query(`SELECT c.relname,c.relkind,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_expression
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname='public' ORDER BY c.relname,a.attnum`)).rows,
    constraints: (await pool.query(`SELECT c.relname,x.conname,x.contype,x.convalidated,pg_get_constraintdef(x.oid) AS definition
      FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' ORDER BY c.relname,x.conname`)).rows,
    functions: (await pool.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind<>'a'
      ORDER BY p.proname,args`)).rows,
    ledger: (await pool.query('SELECT version,name FROM public.schema_migrations ORDER BY version')).rows,
  }
}
try {
  const migrations = join(projectRoot, 'db/migrations'), names = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()
  const partial = join(instance.directory, 'migrations-before-35')
  await mkdir(partial)
  for (const name of names.filter(name => name < '0035_')) await copyFile(join(migrations, name), join(partial, name))
  const pool = await database()
  await check('合成旧基线升级至0034，状态检查只读且待迁移清单准确', async () => {
    const applied = await runMigrations(pool, partial)
    assert.equal(applied.applied.length, names.filter(name => name < '0035_').length)
    const before = await structure(pool), status = await inspectMigrations(pool, migrations)
    assert.equal(status.pending[0], '0035_subscription_entitlements.sql')
    assert.deepEqual(await structure(pool), before)
    return { applied: applied.applied.length, pending: status.pending.length, inspectionReadOnly: true }
  })
  await check('真实0035结构变更后账本写入失败，结构、函数、约束和账本一起回滚', async () => {
    await pool.query(`CREATE FUNCTION public.synthetic_reject_migration() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.version='0035' THEN RAISE EXCEPTION 'synthetic ledger insert failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER synthetic_reject_migration BEFORE INSERT ON public.schema_migrations FOR EACH ROW EXECUTE FUNCTION public.synthetic_reject_migration()`)
    const before = await structure(pool)
    await assert.rejects(runMigrations(pool, migrations), /synthetic ledger insert failure/)
    assert.deepEqual(await structure(pool), before)
    assert.equal((await pool.query("SELECT to_regclass('public.subscription_plan_versions') AS relation")).rows[0].relation, null)
    assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='plan_version_id'")).rows[0].n, 0)
    const contender = new Pool({ ...instance.connection, database: (await pool.query('SELECT current_database() AS db')).rows[0].db, max: 1 })
    try {
      const lock = await contender.query("SELECT pg_try_advisory_lock(hashtext('smartrecruit:migrations')) AS acquired")
      assert.equal(lock.rows[0].acquired, true)
      await contender.query("SELECT pg_advisory_unlock(hashtext('smartrecruit:migrations'))")
    } finally { await contender.end() }
    await pool.query('DROP TRIGGER synthetic_reject_migration ON public.schema_migrations; DROP FUNCTION public.synthetic_reject_migration()')
    return { realHistoricalMigration: '0035', ddlRolledBack: true, ledgerRolledBack: true, lockReleased: true }
  })
  await check('排除注入故障后正常完成全部迁移，重复执行不修改结构与账本', async () => {
    const upgraded = await runMigrations(pool, migrations)
    assert.equal(upgraded.applied[0], '0035_subscription_entitlements.sql')
    const before = await structure(pool), repeated = await runMigrations(pool, migrations)
    assert.deepEqual(repeated.applied, []); assert.equal(repeated.alreadyApplied.length, names.length)
    assert.deepEqual(await structure(pool), before)
    return { total: names.length, upgraded: upgraded.applied.length, idempotent: true }
  })
  const fixture = join(instance.directory, 'synthetic-migration')
  await mkdir(fixture); await writeFile(join(fixture, '0001_synthetic.sql'), 'CREATE TABLE should_not_exist(id int);')
  for (const [kind, sql] of [
    ['table', 'CREATE TABLE synthetic_existing(id int)'],
    ['function', 'CREATE FUNCTION synthetic_existing() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'],
    ['enum', "CREATE TYPE synthetic_existing AS ENUM ('one')"],
    ['domain', 'CREATE DOMAIN synthetic_existing AS int CHECK(VALUE>0)'],
  ]) await check('无账本但已有' + kind + '对象的旧库拒绝自动基线与重放', async () => {
    const existing = await database(); await existing.query(sql)
    await assert.rejects(runMigrations(existing, fixture), /MIGRATION_BASELINE_REQUIRED/)
    assert.equal((await existing.query("SELECT to_regclass('public.schema_migrations') AS ledger,to_regclass('public.should_not_exist') AS target")).rows[0].ledger, null)
    assert.equal((await existing.query("SELECT to_regclass('public.should_not_exist') AS target")).rows[0].target, null)
    return { refusedBeforeMutation: true }
  })
  await check('审批快照在真实PG上拒绝目标、账本和历史SQL变化，匹配审批仅执行剩余SQL', async () => {
    const approvedPool = await database()
    await runMigrations(approvedPool, fixture)
    await writeFile(join(fixture, '0002_approved.sql'), 'CREATE TABLE approved_upgrade(id int);')
    const approval = await inspectMigrationApproval(approvedPool, fixture)
    const before = await structure(approvedPool)
    await assert.rejects(runMigrations(approvedPool, fixture, { approval: { ...approval, identity: { ...approval.identity, databaseOid: '0' } } }), /MIGRATION_APPROVAL_TARGET_CHANGED/)
    assert.deepEqual(await structure(approvedPool), before)
    await writeFile(join(fixture, '0001_synthetic.sql'), 'CREATE TABLE unapproved_rewrite(id int);')
    await assert.rejects(runMigrations(approvedPool, fixture, { approval }), /MIGRATION_APPROVAL_FILES_CHANGED/)
    assert.deepEqual(await structure(approvedPool), before)
    await writeFile(join(fixture, '0001_synthetic.sql'), 'CREATE TABLE should_not_exist(id int);')
    await approvedPool.query("INSERT INTO public.schema_migrations(version,name) VALUES ('0002','0002_approved.sql')")
    const drifted = await structure(approvedPool)
    await assert.rejects(runMigrations(approvedPool, fixture, { approval }), /MIGRATION_APPROVAL_LEDGER_CHANGED/)
    assert.deepEqual(await structure(approvedPool), drifted)
    await approvedPool.query("DELETE FROM public.schema_migrations WHERE version='0002'")
    const result = await runMigrations(approvedPool, fixture, { approval })
    assert.deepEqual(result.applied, ['0002_approved.sql'])
    assert.deepEqual((await inspectMigrationApproval(approvedPool, fixture)).pending, [])
    return { targetDriftRefused: true, ledgerDriftRefused: true, historicalSqlDriftRefused: true, approvedOnly: true }
  })
  report.passed = true
} catch (error) {
  report.passed = false; report.failures.push({ name: error.name, message: error.message, stack: error.stack }); process.exitCode = 1
  console.error('隔离迁移测试失败：' + error.message)
} finally {
  const clean = async (name, action) => { try { await action(); report.cleanup[name] = true } catch (error) { report.failures.push({ cleanup: name, message: error.message }); report.passed = false; process.exitCode = 1 } }
  await clean('poolsClosed', () => Promise.all([...pools].map(pool => pool.end())))
  for (const name of databases) await clean('dropped:' + name, async () => {
    assert.match(name, /^closure_verify_[a-f0-9]{32}$/); await admin.query('DROP DATABASE "' + name + '" WITH (FORCE)')
  })
  await clean('adminClosed', () => admin.end())
  await clean('postgresStopped', () => instance.stop())
  await clean('codeUnchangedDuringRun', async () => assert.equal((await testCodeFingerprint(projectRoot)).sha256, fingerprint.sha256))
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2)); console.log('报告：' + output)
}
