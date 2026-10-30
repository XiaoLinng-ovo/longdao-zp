import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Pool } from 'pg'

export interface MigrationResult {
  applied: string[]
  alreadyApplied: string[]
}

interface MigrationFile {
  version: string
  name: string
  path: string
}

const MIGRATION_NAME = /^(\d+)_([a-z0-9][a-z0-9_-]*)\.sql$/i

async function listMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'))

  const migrations: MigrationFile[] = []
  const versions = new Set<string>()
  for (const name of names) {
    const match = MIGRATION_NAME.exec(name)
    if (!match) throw new Error(`Invalid migration filename: ${name}`)
    const version = match[1]!
    if (versions.has(version)) throw new Error(`Duplicate migration version: ${version}`)
    versions.add(version)
    migrations.push({ version, name, path: join(directory, name) })
  }
  return migrations
}

export async function runMigrations(pool: Pool, directory: string): Promise<MigrationResult> {
  const migrations = await listMigrationFiles(directory)
  const client = await pool.connect()
  const applied: string[] = []
  const alreadyApplied: string[] = []

  try {
    await client.query("SELECT pg_advisory_lock(hashtext('smartrecruit:migrations'))")
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL UNIQUE,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const existing = await client.query<{ version: string; name: string }>(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    )
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

      const sql = await readFile(migration.path, 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name],
        )
        await client.query('COMMIT')
        applied.push(migration.name)
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw new Error(`Migration ${basename(migration.path)} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    }

    return { applied, alreadyApplied }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('smartrecruit:migrations'))").catch(() => undefined)
    client.release()
  }
}
