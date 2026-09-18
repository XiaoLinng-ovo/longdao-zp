import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const DINGTALK_ENV_KEYS = [
  'DINGTALK_APP_KEY',
  'DINGTALK_APP_SECRET',
  'DINGTALK_INTEGRATION_TOKEN',
  'DINGTALK_CALLBACK_TOKEN',
  'DINGTALK_CALLBACK_AES_KEY',
  'DINGTALK_CALLBACK_CORP_ID',
] as const

export type DingTalkEnvKey = typeof DINGTALK_ENV_KEYS[number]
export type DingTalkEnvPatch = Partial<Record<DingTalkEnvKey, string>>
export interface DingTalkEnvSetting { value: string; configured: boolean; masked: boolean }
export type DingTalkEnvSettings = Record<DingTalkEnvKey, DingTalkEnvSetting>
export const RESUME_VIRUS_SCAN_KEY = 'RESUME_VIRUS_SCAN_ENABLED' as const

const SECRET_KEYS = new Set<DingTalkEnvKey>([
  'DINGTALK_APP_SECRET',
  'DINGTALK_INTEGRATION_TOKEN',
  'DINGTALK_CALLBACK_TOKEN',
  'DINGTALK_CALLBACK_AES_KEY',
])

function parseEnv(content: string): Map<string, string> {
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

async function readEnvValues(filePath: string): Promise<Map<string, string>> {
  let content = ''
  try { content = await readFile(filePath, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return parseEnv(content)
}

function mask(value: string): string {
  if (!value) return ''
  if (value.length <= 4) return '••••'
  return `${value.slice(0, 2)}••••${value.slice(-2)}`
}

function emptySettings(values: Map<string, string>): DingTalkEnvSettings {
  return Object.fromEntries(DINGTALK_ENV_KEYS.map((key) => {
    const value = values.get(key) ?? ''
    const masked = SECRET_KEYS.has(key)
    return [key, { value: masked ? mask(value) : value, configured: Boolean(value), masked }]
  })) as DingTalkEnvSettings
}

export function resolveEnvFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.ENV_FILE_PATH?.trim() || resolve(process.cwd(), '.env'))
}

export async function readDingTalkEnvSettings(filePath = resolveEnvFilePath()): Promise<DingTalkEnvSettings> {
  return emptySettings(await readEnvValues(filePath))
}

function validatePatch(patch: DingTalkEnvPatch): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!(DINGTALK_ENV_KEYS as readonly string[]).includes(key)) throw new Error(`不支持的钉钉配置项：${key}`)
    if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`)
    if (/[\r\n]/u.test(value)) throw new Error(`${key} 不能包含换行符`)
  }
}

function replaceEnvLines(content: string, patch: Record<string, string>): string {
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

export async function updateDingTalkEnvSettings(filePath = resolveEnvFilePath(), patch: DingTalkEnvPatch): Promise<DingTalkEnvSettings> {
  validatePatch(patch)
  await mkdir(dirname(filePath), { recursive: true })
  let content = ''
  try { content = await readFile(filePath, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const next = replaceEnvLines(content, patch)
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporaryPath, next, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, filePath)
  for (const [key, value] of Object.entries(patch)) process.env[key] = value
  return readDingTalkEnvSettings(filePath)
}

export async function readResumeVirusScanSetting(filePath = resolveEnvFilePath()): Promise<boolean> {
  return (await readEnvValues(filePath)).get(RESUME_VIRUS_SCAN_KEY)?.trim().toLowerCase() === 'true'
}

export async function updateResumeVirusScanSetting(filePath = resolveEnvFilePath(), enabled: boolean): Promise<boolean> {
  validatePatch({} as DingTalkEnvPatch)
  await mkdir(dirname(filePath), { recursive: true })
  const content = await readFile(filePath, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  const next = replaceEnvLines(content, { [RESUME_VIRUS_SCAN_KEY]: String(enabled) })
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporaryPath, next, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, filePath)
  process.env[RESUME_VIRUS_SCAN_KEY] = String(enabled)
  return enabled
}
