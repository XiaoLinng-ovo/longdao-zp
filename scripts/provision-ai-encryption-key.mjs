/** Provision once. Never prints the value; keep the server .env or secret-manager version backed up. */
import '../apps/api/dist/src/env.js'
import { randomBytes } from 'node:crypto'
import { resolveEnvFilePath, readEnvValues, writeEnvFile } from '../apps/api/dist/src/admin/env-file.js'

const valid = value => typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/u.test(value) && Buffer.from(value, 'base64').length === 32
const path = resolveEnvFilePath()
const values = await readEnvValues(path)
const existing = process.env.AI_CONFIG_ENCRYPTION_KEY ?? values.get('AI_CONFIG_ENCRYPTION_KEY')
if (existing !== undefined) {
  if (!valid(existing)) throw new Error('AI_CONFIG_ENCRYPTION_KEY is invalid; refuse to replace an existing key automatically')
  console.log('AI encryption key already provisioned; preserved without displaying it')
} else {
  await writeEnvFile(path, { AI_CONFIG_ENCRYPTION_KEY: randomBytes(32).toString('base64') })
  console.log('AI encryption key provisioned in the server env file; back up this file securely and restart API/worker')
}
