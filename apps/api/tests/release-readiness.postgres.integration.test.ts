import { assertDisposableTestDatabase } from './helpers/disposable-database.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Pool } from 'pg'
import { assertReleaseReady, listMigrationFiles } from '@smartrecruit-pro/database-readiness'
import { loadDatabaseConfig } from '../src/db/config.js'

test('isolated PostgreSQL: read-only release gate rejects historical gaps, company drift, future versions and storage moves', async () => {
  assertDisposableTestDatabase()
  const config = loadDatabaseConfig()
  const pool = new Pool(config)
  const readonly = new Pool({ ...config, max: 1, options: '-c default_transaction_read_only=on' })
  const options = {
    migrationsDirectory: fileURLToPath(new URL('../../../../db/migrations/', import.meta.url)),
    tenantRouting: true,
    storageLocations: { resume: 'a'.repeat(64), interview: 'b'.repeat(64) },
  }
  const id = randomUUID(), key = 'synthetic-release/' + randomUUID()
  try {
    const original = await assertReleaseReady(readonly, options)
    assert.equal(original.migrations, (await listMigrationFiles(options.migrationsDirectory)).length)
    await assert.rejects(assertReleaseReady(readonly, { ...options, tenantRouting: false }), /必须启用公司 Schema/)
    await pool.query("INSERT INTO public.organizations(id,name,kind,service_status) VALUES($1,'合成发布验收公司','test','enabled')", [id])
    await assert.rejects(assertReleaseReady(readonly, options), /公司 Schema 未就绪/)
    await pool.query('SELECT public.initialize_organization_schema($1)', [id])
    assert.equal((await assertReleaseReady(readonly, options)).companies, original.companies + 1)
    const schema = 'company_' + id.replaceAll('-', '')
    // Structural damage despite a complete ledger must still block the release.
    await pool.query('ALTER TABLE "' + schema + '".resumes RENAME COLUMN original_filename TO temporarily_missing_filename')
    await assert.rejects(assertReleaseReady(readonly, options), /公司 Schema 未就绪/)
    await pool.query('ALTER TABLE "' + schema + '".resumes RENAME COLUMN temporarily_missing_filename TO original_filename')
    await pool.query("INSERT INTO public.stored_object_locations(organization_id,storage_kind,storage_key,location_id) VALUES($1,'resume',$2,$3)", [id, key, 'c'.repeat(64)])
    await assert.rejects(assertReleaseReady(readonly, options), /存储位置不一致/)
    await pool.query('DELETE FROM public.stored_object_locations WHERE organization_id=$1 AND storage_key=$2', [id, key])
    const latest = (await pool.query('DELETE FROM public.schema_migrations WHERE version=(SELECT max(version) FROM public.schema_migrations) RETURNING version,name')).rows[0]
    try { await assert.rejects(assertReleaseReady(readonly, options), /待迁移文件/) }
    finally { await pool.query('INSERT INTO public.schema_migrations(version,name) VALUES($1,$2)', [latest.version, latest.name]) }
    await pool.query("INSERT INTO public.schema_migrations(version,name) VALUES('999901','999901_future_fixture.sql')")
    try { await assert.rejects(assertReleaseReady(readonly, options), /Unknown database migration/) }
    finally { await pool.query("DELETE FROM public.schema_migrations WHERE version='999901'") }
    await assertReleaseReady(readonly, options)
    assert.equal((await readonly.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only, 'on')
    const sizeBefore = (await pool.query('SELECT count(*)::integer AS count FROM public.schema_migrations')).rows[0].count
    let snapshots = 0
    readonly.on('acquire', () => { snapshots++ })
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => assertReleaseReady(readonly, options)))
    assert.equal(snapshots, 1)
    for (const result of concurrent) assert.deepEqual(result, { ...original, companies: original.companies + 1 })
    await assertReleaseReady(readonly, options)
    assert.equal(snapshots, 2, 'a completed result must not bypass the next database check')
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM public.schema_migrations')).rows[0].count, sizeBefore)
  } finally {
    // The harness drops this complete random database; never copy these fixtures to a business database.
    await readonly.end()
    await pool.end()
  }
})
