import { readEnvValues, resolveEnvFilePath, writeEnvFile } from './env-file.js'

export const DINGTALK_ENV_KEYS = [
  'DINGTALK_APP_KEY',
  'DINGTALK_APP_SECRET',
  'DINGTALK_INTEGRATION_TOKEN',
  'DINGTALK_CALLBACK_TOKEN',
  'DINGTALK_CALLBACK_AES_KEY',
  'DINGTALK_CALLBACK_CORP_ID',
  'DINGTALK_CALLBACK_BASE_URL',
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

export { resolveEnvFilePath }

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

export async function updateDingTalkEnvSettings(filePath = resolveEnvFilePath(), patch: DingTalkEnvPatch): Promise<DingTalkEnvSettings> {
  validatePatch(patch)
  await writeEnvFile(filePath, patch)
  return readDingTalkEnvSettings(filePath)
}

export async function readResumeVirusScanSetting(filePath = resolveEnvFilePath()): Promise<boolean> {
  return (await readEnvValues(filePath)).get(RESUME_VIRUS_SCAN_KEY)?.trim().toLowerCase() === 'true'
}

export async function updateResumeVirusScanSetting(filePath = resolveEnvFilePath(), enabled: boolean): Promise<boolean> {
  await writeEnvFile(filePath, { [RESUME_VIRUS_SCAN_KEY]: String(enabled) })
  return enabled
}
