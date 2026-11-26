import '../apps/api/dist/src/env.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadDatabaseConfig, createDatabasePool } from '../apps/api/dist/src/db/index.js'

const [templateId, organizationId, mode = 'check'] = process.argv.slice(2)
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu
if (!uuid.test(templateId ?? '') || !uuid.test(organizationId ?? '') || !['check', 'apply'].includes(mode)) {
  throw new Error('Usage: node scripts/fix-offer-reporting-location-template.mjs TEMPLATE_ID ORGANIZATION_ID [check|apply]')
}

const pool = createDatabasePool(loadDatabaseConfig())
const client = await pool.connect()
try {
  const tenantSchema = `company_${organizationId.replaceAll('-', '').toLowerCase()}`
  const schemaExists = await client.query('SELECT to_regclass($1) AS relation', [`${tenantSchema}.offer_templates`])
  const schema = schemaExists.rows[0].relation ? tenantSchema : 'public'
  await client.query('BEGIN')
  await client.query("SET LOCAL lock_timeout = '3s'")
  const result = await client.query(`SELECT * FROM ${schema}.offer_templates WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE`, [templateId, organizationId])
  const original = result.rows[0]
  if (!original) throw new Error('Target template not found in the specified organization')
  const content = original.content.replace(/杭州市余杭区(?:城投未来之星|未来科技城)\s*C2\s*幢\s*(?:21\s*楼\s*)?2105\s*室/gu, '{{报到地点}}')
  console.log(JSON.stringify({ schema, name: original.name, needsUpdate: content !== original.content }))
  if (mode !== 'apply' || content === original.content) {
    await client.query('ROLLBACK')
  } else {
    const directory = resolve('.codex-artifacts', 'offer-template-backups')
    await mkdir(directory, { recursive: true })
    const backup = resolve(directory, `${templateId}-${Date.now()}.json`)
    await writeFile(backup, JSON.stringify({ schema, original }, null, 2), { encoding: 'utf8', flag: 'wx' })
    const savedBackup = JSON.parse(await readFile(backup, 'utf8'))
    if (savedBackup.original.content !== original.content) throw new Error('Backup verification failed')
    const updated = await client.query(`UPDATE ${schema}.offer_templates SET content=$3 WHERE id=$1::uuid AND organization_id=$2::uuid RETURNING content`, [templateId, organizationId, content])
    if (updated.rowCount !== 1 || updated.rows[0].content !== content) throw new Error('Template update verification failed')
    await client.query('COMMIT')
    console.log(JSON.stringify({ updated: true, backup, paragraph: content.match(/<p>[^<]*请您于[\s\S]*?<\/p>/u)?.[0] ?? '{{报到地点}}' }))
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined)
  throw error
} finally {
  client.release()
  await pool.end()
}
