import { control } from './runtime-control.mjs'

try {
  const result = await control(process.argv.includes('--dry-run') ? 'doctor' : 'start', { args: process.argv.slice(2) })
  console.log(JSON.stringify(result, null, 2))
  if (!result.ready) process.exitCode = 1
} catch (error) { console.error(error.message); process.exitCode = 1 }
