import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '/app/apps/api/dist/src/db/migrations.js'
import { assertReleaseReady } from '/app/packages/database-readiness/index.js'
import { readFile } from 'node:fs/promises'

// This helper only runs in a labelled, private-network synthetic acceptance container.
assert.equal(process.env.CONTAINER_ACCEPTANCE, 'isolated-synthetic')
assert.match(process.env.PGDATABASE ?? '', /^closure_[a-f0-9]{32}$/)
assert.match(process.env.PGHOST ?? '', /^closure_[a-f0-9]{32}_postgres$/)
const require = createRequire('/app/apps/api/package.json')
const { Pool } = require('pg'), pool = new Pool({ max: 2 })
const quote = value => '"' + value.replaceAll('"', '""') + '"'
const options = { migrationsDirectory: '/app/db/migrations', tenantRouting: true,
  storageLocations: { resume: 'a'.repeat(64), interview: 'a'.repeat(64) } }
const mode = process.argv[2]
try {
  const identity = (await pool.query("SELECT current_database() AS database,current_user AS role,current_setting('cluster_name') AS cluster,current_setting('server_version') AS version")).rows[0]
  assert.equal(identity.database, process.env.PGDATABASE)
  assert.equal(identity.cluster, process.env.PGDATABASE)
  assert.equal(identity.role, 'closure_owner')
  assert.match(identity.version, /^16\./)
  if (mode === 'prepare') {
    await runMigrations(pool, '/acceptance/migrations-through-74')
    const createCompany = async () => {
      const id = randomUUID()
      await pool.query("INSERT INTO public.organizations(id,name,kind,service_status) VALUES($1,'Container synthetic company','test','enabled')", [id])
      return (await pool.query('SELECT public.initialize_organization_schema($1) AS schema', [id])).rows[0].schema
    }
    const historical = await createCompany()
    const migrated = await runMigrations(pool, '/app/db/migrations')
    const current = await createCompany()
    const ready = await assertReleaseReady(pool, options)
    const again = await runMigrations(pool, '/app/db/migrations')
    assert.equal(again.applied.length, 0)
    const definitions = await pool.query("SELECT pg_get_functiondef('public.guard_object_reference()'::regprocedure) AS definition")
    await pool.query('CREATE OR REPLACE FUNCTION public.guard_object_reference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$')
    try { await assert.rejects(assertReleaseReady(pool, options), /结构契约/) }
    finally { await pool.query(definitions.rows[0].definition) }
    const constraint = (await pool.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid=$1::regclass AND contype='f' AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (resume_id)%'`, [quote(historical) + '.analysis_tasks'])).rows[0]
    assert.ok(constraint)
    await pool.query('ALTER TABLE ' + quote(historical) + '.analysis_tasks DROP CONSTRAINT ' + quote(constraint.conname))
    try { await assert.rejects(assertReleaseReady(pool, options), /结构契约/) }
    finally { await pool.query('ALTER TABLE ' + quote(historical) + '.analysis_tasks ADD CONSTRAINT ' + quote(constraint.conname) + ' ' + constraint.definition) }
    await assertReleaseReady(pool, options)
    console.log(JSON.stringify({ identity, ready, historical, current, upgraded: migrated.applied.length,
      idempotent: true, functionTamperRejected: true, historicalForeignKeyDamageRejected: true }))
  } else if (mode === 'connections') {
    const rows = (await pool.query("SELECT application_name,state,count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() GROUP BY application_name,state ORDER BY application_name,state")).rows
    console.log(JSON.stringify({ identity, connections: rows }))
    assert.equal(rows.length, 0, '服务关停后必须没有残留数据库连接')
  } else if (mode === 'damage' || mode === 'restore') {
    // Deliberately committed damage checks the real entrypoints, not an injected readiness callback.
    await pool.query('ALTER TABLE public.resumes ' + (mode === 'damage' ? 'DISABLE' : 'ENABLE') + ' TRIGGER guard_object_reference')
    console.log(JSON.stringify({ identity, mode }))
  } else if (mode === 'health') {
    const result = await fetch('http://127.0.0.1:' + process.argv[3] + process.argv[4], { signal: AbortSignal.timeout(5000) })
    assert.equal(result.status, 200)
    console.log(JSON.stringify({ status: result.status, body: await result.json() }))
  } else if (mode === 'compare') {
    const { captureStructure, normalizeStructure } = await import('/app/packages/database-readiness/structure-contract.js')
    const contract = JSON.parse(await readFile('/app/packages/database-readiness/structure-contract.json', 'utf8'))
    const actual = normalizeStructure(await captureStructure(pool, ['public']), 'public')
    const differences = actual.filter(row => JSON.stringify(row) !== JSON.stringify(contract.public.find(item => item.kind === row.kind && item.name === row.name)))
    console.log(JSON.stringify({ identity, differences }))
  } else throw new Error('未知容器验收子命令')
} finally { await pool.end() }
