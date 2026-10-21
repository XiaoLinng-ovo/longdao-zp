import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function parseEnvFile(content: string): void {
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1)
    }
    if (key && process.env[key] === undefined) process.env[key] = value
  }
}

/** Load the same repository .env file used by the API so background workers see model settings. */
export function loadEnvironment(): void {
  const configured = process.env.ENV_FILE_PATH?.trim()
  const candidates = [
    configured ? resolve(configured) : undefined,
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '..', '.env'),
    resolve(process.cwd(), '..', '..', '.env'),
  ].filter((value): value is string => Boolean(value))
  const file = candidates.find((candidate) => existsSync(candidate))
  if (file) parseEnvFile(readFileSync(file, 'utf8'))
}
