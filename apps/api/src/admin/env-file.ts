/**
 * .env 文件的读取与原子写入。
 * 钉钉集成配置与 AI 模型配置共用这套原语，保证写入方式与权限一致。
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export function resolveEnvFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.ENV_FILE_PATH?.trim() || resolve(process.cwd(), '.env'))
}

export function parseEnv(content: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1)
    values.set(key, value)
  }
  return values
}

export async function readEnvValues(filePath: string): Promise<Map<string, string>> {
  let content = ''
  try { content = await readFile(filePath, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return parseEnv(content)
}

export function replaceEnvLines(content: string, patch: Record<string, string>): string {
  const lines = content.split(/(\r?\n)/u)
  const seen = new Set<string>()
  const output = lines.map((part) => {
    if (part === '\n' || part === '\r\n') return part
    const match = part.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=.*)$/u)
    if (!match || !(match[2] as string in patch)) return part
    const key = match[2] as string
    seen.add(key)
    return `${match[1]}${key}=${patch[key] ?? ''}`
  }).join('')
  const missing = Object.keys(patch).filter((key) => !seen.has(key)).map((key) => `${key}=${patch[key] ?? ''}`)
  if (!missing.length) return output
  return `${output}${output && !output.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`
}

/** 原子写入 .env，并立即让当前进程生效（无需重启即可被后续请求读取）。 */
export async function writeEnvFile(filePath: string, patch: Record<string, string>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const content = await readFile(filePath, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  const next = replaceEnvLines(content, patch)
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporaryPath, next, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, filePath)
  for (const [key, value] of Object.entries(patch)) process.env[key] = value
}
