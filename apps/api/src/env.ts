import { existsSync, readFileSync } from 'node:fs'
import { envFileCandidates } from './admin/env-file.js'

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

/**
 * 依次加载候选 .env（ENV_FILE_PATH → apps/api/.env → 仓库根 .env），先出现的文件优先。
 * 逐个文件合并而不是只用第一个存在的文件，避免后台写入的那份配置被另一份文件整体顶掉。
 * 已存在于 process.env 的值不会被覆盖。
 */
export function loadEnvironment(): void {
  for (const file of envFileCandidates()) {
    if (!existsSync(file)) continue
    parseEnvFile(readFileSync(file, 'utf8'))
  }
}

loadEnvironment()
