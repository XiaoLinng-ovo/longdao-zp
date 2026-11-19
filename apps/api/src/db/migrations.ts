import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { listMigrationFiles, validateMigrationLedger } from '@smartrecruit-pro/database-readiness'
import type { Pool, PoolClient } from 'pg'
import { prepareMigrationSql } from './migration-sql.js'

export interface MigrationResult {
  applied: string[]
  alreadyApplied: string[]
}

export interface MigrationStatus {
  applied: string[]
  pending: string[]
  ledgerExists: boolean
}

export interface MigrationApprovalSnapshot {
  identity: { database: string; databaseOid: string; serverAddress: string; serverPort: number }
  ledger: { version: string; name: string }[]
  files: { name: string; sha256: string }[]
  pending: string[]
}

async function migrationIdentity(client: PoolClient): Promise<MigrationApprovalSnapshot['identity']> {
  return (await client.query<MigrationApprovalSnapshot['identity']>(`
    SELECT current_database() AS database, d.oid::text AS "databaseOid",
      host(inet_server_addr()) AS "serverAddress", inet_server_port() AS "serverPort"
    FROM pg_catalog.pg_database d WHERE d.datname=current_database()
  `)).rows[0]!
}

function sameSnapshot(actual: MigrationApprovalSnapshot, expected: MigrationApprovalSnapshot): void {
  if (!expected || JSON.stringify(actual.identity) !== JSON.stringify(expected.identity))
    throw new Error('MIGRATION_APPROVAL_TARGET_CHANGED: Generate and review a new plan for this database.')
  for (const field of ['ledger', 'files', 'pending'] as const) {
    if (JSON.stringify(actual[field]) !== JSON.stringify(expected[field]))
      throw new Error(`MIGRATION_APPROVAL_${field.toUpperCase()}_CHANGED: Refuse unapproved SQL or ledger changes; generate and review a new plan.`)
  }
}

/** Approval snapshots contain no credentials or business rows. This never creates a ledger. */
export async function inspectMigrationApproval(pool: Pool, directory: string): Promise<MigrationApprovalSnapshot> {
  const migrations = await listMigrationFiles(directory)
  const files = await Promise.all(migrations.map(async migration => ({ name: migration.name,
    sha256: createHash('sha256').update(await readFile(migration.path)).digest('hex') })))
  const client = await pool.connect()
  let transaction = false, broken = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transaction = true
    await client.query("SET LOCAL statement_timeout='30s'")
    const identity = await migrationIdentity(client)
    const exists = (await client.query("SELECT to_regclass('public.schema_migrations') AS ledger")).rows[0]?.ledger
    if (!exists) throw new Error('MIGRATION_APPROVAL_BASELINE_REQUIRED: Approved maintenance requires an existing migration ledger.')
    const ledger = (await client.query<{ version: string; name: string }>('SELECT version,name FROM public.schema_migrations ORDER BY version')).rows
    validateMigrationLedger(migrations, ledger)
    const applied = new Set(ledger.map(row => row.version))
    const pending = migrations.filter(file => !applied.has(file.version)).map(file => file.name)
    await client.query('COMMIT')
    transaction = false
    return { identity, ledger, files, pending }
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK') } catch { broken = true } }
    throw error
  } finally { client.release(broken) }
}

/** Read-only preflight: never create the ledger or apply SQL. */
export async function inspectMigrations(pool: Pool, directory: string): Promise<MigrationStatus> {
  const migrations = await listMigrationFiles(directory)
  const client = await pool.connect()
  try {
    const ledgerExists = Boolean((await client.query("SELECT to_regclass('public.schema_migrations') AS ledger")).rows[0]?.ledger)
    const existing = ledgerExists
      ? (await client.query<{ version: string; name: string }>('SELECT version, name FROM public.schema_migrations ORDER BY version')).rows
      : []
    validateMigrationLedger(migrations, existing)
    const recorded = new Map(existing.map(row => [row.version, row.name]))
    const applied: string[] = [], pending: string[] = []
    for (const migration of migrations) {
      const name = recorded.get(migration.version)
      if (name !== undefined && name !== migration.name)
        throw new Error(`Migration version ${migration.version} is recorded as ${name}, found ${migration.name}`)
      if (name === undefined) pending.push(migration.name)
      else applied.push(migration.name)
    }
    return { applied, pending, ledgerExists }
  } finally { client.release() }
}

export async function runMigrations(pool: Pool, directory: string, options: { approval?: MigrationApprovalSnapshot } = {}): Promise<MigrationResult> {
  const migrations = await listMigrationFiles(directory)
  const client = await pool.connect()
  const applied: string[] = []
  const alreadyApplied: string[] = []
  let broken = false

  try {
    await client.query("SELECT pg_advisory_lock(hashtext('smartrecruit:migrations'))")
    const ledgerExists = Boolean((await client.query("SELECT to_regclass(format('%I.schema_migrations', current_schema())) AS ledger")).rows[0]?.ledger)
    const existing = ledgerExists
      ? await client.query<{ version: string; name: string }>('SELECT version, name FROM schema_migrations ORDER BY version')
      : { rows: [] }
    validateMigrationLedger(migrations, existing.rows)
    // Pin approved bytes before any DDL; execution never reopens these files.
    const approvedSql = new Map<string, string>()
    if (options.approval) {
      const files = []
      for (const migration of migrations) {
        const bytes = await readFile(migration.path)
        files.push({ name: migration.name, sha256: createHash('sha256').update(bytes).digest('hex') })
        approvedSql.set(migration.name, bytes.toString('utf8'))
      }
      const applied = new Set(existing.rows.map(row => row.version))
      sameSnapshot({ identity: await migrationIdentity(client), ledger: existing.rows, files,
        pending: migrations.filter(file => !applied.has(file.version)).map(file => file.name) }, options.approval)
      if (!ledgerExists || !existing.rows.length) throw new Error('MIGRATION_APPROVAL_BASELINE_REQUIRED: Refuse unapproved baseline creation.')
    }
    if (!existing.rows.length) {
      const objects = await client.query(`
        SELECT c.relname AS object_name FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND c.relname <> 'schema_migrations'
          AND c.relkind IN ('r','p','v','m','f','S')
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
            WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
        UNION ALL
        SELECT p.proname FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=current_schema()
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
            WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
        UNION ALL
        SELECT t.typname FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
        WHERE n.nspname=current_schema()
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
            WHERE d.classid='pg_catalog.pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
        LIMIT 1
      `)
      if (objects.rows.length) throw new Error('MIGRATION_BASELINE_REQUIRED: existing database objects have no recorded migrations; refuse automatic replay. Verify a backup and approve a baseline recovery plan first.')
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL UNIQUE,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const appliedByVersion = new Map(existing.rows.map((row) => [row.version, row.name]))

    for (const migration of migrations) {
      const recordedName = appliedByVersion.get(migration.version)
      if (recordedName !== undefined) {
        if (recordedName !== migration.name) {
          throw new Error(`Migration version ${migration.version} is recorded as ${recordedName}, found ${migration.name}`)
        }
        alreadyApplied.push(migration.name)
        continue
      }

      const sql = prepareMigrationSql(approvedSql.get(migration.name) ?? await readFile(migration.path, 'utf8'))
      await client.query('BEGIN')
      try {
        await client.query('SET LOCAL standard_conforming_strings=on')
        await client.query(sql)
        await client.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name],
        )
        await client.query('COMMIT')
        applied.push(migration.name)
      } catch (error) {
        try { await client.query('ROLLBACK') } catch { broken = true }
        throw new Error(`Migration ${basename(migration.path)} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    }

    return { applied, alreadyApplied }
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(hashtext('smartrecruit:migrations'))") } catch { broken = true }
    client.release(broken)
  }
}
