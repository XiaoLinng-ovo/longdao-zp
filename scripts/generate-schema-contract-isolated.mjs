import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { listMigrationFiles } from '../packages/database-readiness/index.js'
import { captureStructure, migrationSignatures, normalizeStructure } from '../packages/database-readiness/structure-contract.js'

const argument = process.argv.indexOf('--postgres-bin')
assert.ok(argument >= 0 && process.argv[argument + 1])
assert.ok(process.argv.includes('--write-contract'), '生成源码结构契约须显式传入 --write-contract')
const instance = await startIsolatedPostgres(process.argv[argument + 1])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env)
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
const { Pool } = require('pg'), admin = new Pool(instance.connection)
let pool, created = false
try {
  await admin.query('CREATE DATABASE "' + instance.database + '"'); created = true
  pool = new Pool({ ...instance.connection, database: instance.database })
  const { runMigrations } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/db/migrations.js')))
  const migrations = join(projectRoot, 'db/migrations')
  await runMigrations(pool, migrations)
  const id = '6f3505f8-5967-47f9-9f2b-f08a55c12a3d'
  await pool.query("INSERT INTO public.organizations(id,name,kind,service_status) VALUES($1,'结构契约合成公司','test','enabled')", [id])
  const schema = (await pool.query('SELECT public.initialize_organization_schema($1) AS schema', [id])).rows[0].schema
  const client = await pool.connect()
  let rows
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query('SET LOCAL search_path=pg_catalog,public')
    rows = await captureStructure(client, ['public', schema, 'recovery_control'])
    await client.query('COMMIT')
  } finally { client.release() }
  const contract = { format: 1, provenance: '由全部真实迁移创建的全新隔离库生成；不是历史已执行SQL摘要证明',
    generatedOn: (await pool.query('SHOW server_version')).rows[0].server_version,
    migrations: await migrationSignatures(await listMigrationFiles(migrations)),
    public: normalizeStructure(rows, 'public'), company: normalizeStructure(rows, schema, id), control: normalizeStructure(rows, 'recovery_control') }
  const outputArg = process.argv.indexOf('--output')
  const output = outputArg < 0 ? join(projectRoot, 'packages/database-readiness/structure-contract.json') : resolve(process.argv[outputArg + 1])
  await writeFile(output, JSON.stringify(contract, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ output, publicObjects: contract.public.length, companyObjects: contract.company.length, server: contract.generatedOn }))
} finally {
  await pool?.end()
  if (created) await admin.query('DROP DATABASE "' + instance.database + '" WITH (FORCE)')
  await admin.end(); await instance.stop()
}
