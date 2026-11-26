import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertStructureContract, readStructureContract } from './structure-contract.js'

const migrationName = /^(\d+)_([a-z0-9][a-z0-9_-]*)\.sql$/i
const inFlightChecks = new WeakMap()

export async function listMigrationFiles(directory) {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.sql')).map(entry => entry.name)
  const versions = new Set()
  const files = names.map(name => {
    const match = migrationName.exec(name)
    if (!match) throw new Error('Invalid migration filename: ' + name)
    const version = match[1], numeric = BigInt(version).toString()
    if (versions.has(numeric)) throw new Error('Duplicate migration version: ' + version)
    versions.add(numeric)
    return { version, name, path: join(directory, name) }
  })
  return files.sort((a, b) => BigInt(a.version) < BigInt(b.version) ? -1 : 1)
}

export function validateMigrationLedger(migrations, rows) {
  const files = new Map(migrations.map(file => [file.version, file.name]))
  const seen = new Set()
  for (const row of rows) {
    if (!files.has(row.version)) throw new Error('Unknown database migration version: ' + row.version)
    if (seen.has(row.version)) throw new Error('Duplicate database migration version: ' + row.version)
    seen.add(row.version)
    if (files.get(row.version) !== row.name)
      throw new Error('Migration version ' + row.version + ' is recorded as ' + row.name + ', found ' + files.get(row.version))
  }
}

// Required columns supplement the ledger: a recorded migration is not proof that its tables survived.
const requiredColumns = {
  organization_schemas: ['organization_id', 'schema_name', 'status'],
  stored_object_locations: ['organization_id', 'storage_kind', 'storage_key', 'location_id'],
  object_cleanup_tasks: ['status', 'storage_location_id', 'lease_token'],
  object_write_intents: ['attempt_id', 'status', 'location_id', 'lease_until'],
  object_deletion_fences: ['storage_kind', 'storage_key', 'location_id'],
  full_audio_transcription_tasks: ['status', 'lease_token'],
  offer_email_deliveries: ['status', 'message_id', 'schema_name'],
}

/** Only a consistent, bounded read-only transaction; never repair, seed or migrate here. */
export async function assertReleaseReady(pool, options) {
  if (options.tenantRouting !== true) throw new Error('发布门禁：必须启用公司 Schema 路由，禁止回退公共业务表')
  const { resume, interview } = options.storageLocations
  for (const [kind, location] of Object.entries({ resume, interview })) {
    if (typeof location !== 'string' || !/^[a-f0-9]{64}$/.test(location))
      throw new Error('发布门禁：缺少有效存储位置标识（' + kind + '）')
  }
  const directory = resolve(options.migrationsDirectory)
  const key = JSON.stringify([directory, resume, interview])
  let checks = inFlightChecks.get(pool)
  if (!checks) inFlightChecks.set(pool, checks = new Map())
  let pending = checks.get(key)
  if (!pending) {
    // Only overlapping callers share the same full check, including validation of the release files.
    pending = checkReleaseSnapshot(pool, directory, resume, interview).finally(() => {
      checks.delete(key)
      if (checks.size === 0) inFlightChecks.delete(pool)
    })
    checks.set(key, pending)
  }
  return { ...await pending }
}

async function checkReleaseSnapshot(pool, directory, resumeLocation, interviewLocation) {
  const files = await listMigrationFiles(directory)
  if (!files.length) throw new Error('发布门禁：迁移清单为空')
  const structureContract = await readStructureContract(files)
  const client = await pool.connect()
  let transaction = false, broken = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transaction = true
    await client.query("SET LOCAL statement_timeout='30s'")
    await client.query("SET LOCAL lock_timeout='5s'")
    await client.query('SET LOCAL search_path=pg_catalog,public')
    const exists = (await client.query("SELECT to_regclass('public.schema_migrations') AS ledger")).rows[0]?.ledger
    if (!exists) throw new Error('发布门禁：缺少迁移记录；请先在获准的维护窗口升级')
    const rows = (await client.query('SELECT version,name FROM public.schema_migrations ORDER BY version')).rows
    validateMigrationLedger(files, rows)
    const applied = new Set(rows.map(row => row.version))
    const pending = files.filter(file => !applied.has(file.version))
    if (pending.length) throw new Error('发布门禁：存在待迁移文件：' + pending.map(file => file.name).join(', '))
    const columns = (await client.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])", [Object.keys(requiredColumns)])).rows
    const present = new Set(columns.map(row => row.table_name + '.' + row.column_name))
    for (const [table, names] of Object.entries(requiredColumns)) {
      for (const name of names) if (!present.has(table + '.' + name))
        throw new Error('发布门禁：缺少必要结构 public.' + table + '.' + name)
    }
    const installed = (await client.query("SELECT to_regprocedure('public.organization_schema_structure_ready(uuid)') IS NOT NULL AND to_regprocedure('public.organization_business_tables()') IS NOT NULL AS installed")).rows[0]?.installed
    if (!installed) throw new Error('发布门禁：公司结构校验函数缺失')
    const companies = (await client.query("SELECT o.id AS organization_id,s.schema_name,s.status,public.organization_schema_structure_ready(o.id) AS structure_ready FROM public.organizations o LEFT JOIN public.organization_schemas s ON s.organization_id=o.id WHERE o.status='active' ORDER BY o.id")).rows
    for (const company of companies) {
      const expected = 'company_' + company.organization_id.replaceAll('-', '').toLowerCase()
      if (!/^company_[a-f0-9]{32}$/.test(expected) || company.schema_name !== expected || company.status !== 'ready' || !company.structure_ready)
        throw new Error('发布门禁：公司 Schema 未就绪：' + company.organization_id)
    }
    await assertStructureContract(client, structureContract, companies)
    const mismatches = (await client.query("SELECT storage_kind,count(*)::integer AS count FROM public.stored_object_locations WHERE (storage_kind='resume' AND location_id<>$1) OR (storage_kind='interview' AND location_id<>$2) GROUP BY storage_kind", [resumeLocation, interviewLocation])).rows
    if (mismatches.length) throw new Error('发布门禁：已登记文件与当前存储位置不一致：' + mismatches.map(row => row.storage_kind + '(' + row.count + ')').join(', '))
    await client.query('COMMIT')
    transaction = false
    return { migrations: files.length, companies: companies.length, knownStorageLocationsChecked: true }
  } catch (error) {
    if (transaction) {
      try { await client.query('ROLLBACK') } catch { broken = true }
    }
    throw error
  } finally { client.release(broken) }
}
