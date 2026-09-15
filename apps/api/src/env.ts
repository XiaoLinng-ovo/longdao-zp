import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function parseEnvFile(content: string): void {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!key) continue
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2) {
      const first = value[0]!
      const last = value[value.length - 1]!
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1)
      }
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function findApiRoot(start: string): string {
  let dir = start
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(resolve(dir, 'package.json'))) return dir
    dir = resolve(dir, '..')
  }
  return process.cwd()
}

/**
 * Loads local development configuration from the repository root `.env` file.
 * The root `.env` is intentionally outside `apps/api` so that the same
 * PostgreSQL settings are shared by migration and API processes.
 */
export function loadEnvironment(): void {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const apiRoot = findApiRoot(moduleDir)
  const candidates = [resolve(apiRoot, '.env'), resolve(apiRoot, '..', '.env')]
  const file = candidates.find((candidate) => existsSync(candidate))
  if (!file) return
  parseEnvFile(readFileSync(file, 'utf8'))
}

loadEnvironment()
