import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export function createRuntimeLog(file, env = process.env, { maxBytes = 5 * 1024 * 1024, copies = 4 } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  const secrets = Object.entries(env).filter(([key, value]) => /SECRET|PASSWORD|TOKEN|API_KEY|ENCRYPTION_KEY/iu.test(key) && value?.length >= 6).map(([, value]) => value)
  let bytes = existsSync(file) ? statSync(file).size : 0
  const redact = text => {
    for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]')
    return text.replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/giu, '$1[REDACTED]@').replace(/Bearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
  }
  return (level, ...args) => {
    const message = redact(args.map(value => value instanceof Error ? value.name + ': ' + value.message : typeof value === 'string' ? value : '[structured log omitted]').join(' ')).slice(0, 8192)
    const line = JSON.stringify({ at: new Date().toISOString(), level, message }) + '\n'
    if (bytes + Buffer.byteLength(line) > maxBytes) {
      if (existsSync(file + '.' + copies)) unlinkSync(file + '.' + copies)
      for (let n = copies - 1; n > 0; n--) if (existsSync(file + '.' + n)) renameSync(file + '.' + n, file + '.' + (n + 1))
      if (existsSync(file)) renameSync(file, file + '.1')
      bytes = 0
    }
    appendFileSync(file, line, { mode: 0o600 })
    bytes += Buffer.byteLength(line)
  }
}
