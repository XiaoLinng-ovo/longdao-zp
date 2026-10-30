import { readEnvValues, resolveEnvFilePath, writeEnvFile } from '../../admin/env-file.js'
import { CHANNEL_PROVIDERS, channelEnvKeys, channelProviderDefinition } from './providers.js'
import type { ChannelConnectionInput, ChannelEnvKey, ChannelProvider } from './types.js'

export interface ChannelEnvSetting {
  value: string
  configured: boolean
  masked: boolean
}

export interface ChannelSettingsView {
  id: ChannelProvider
  name: string
  description: string
  enabled: boolean
  configured: boolean
  missing: ChannelEnvKey[]
  values: Record<string, ChannelEnvSetting>
  fields: ReturnType<typeof channelProviderDefinition>['fields']
  capabilities: ReturnType<typeof channelProviderDefinition>['capabilities']
}

export type ChannelSettings = Record<ChannelProvider, ChannelSettingsView>

export class ChannelSettingsValidationError extends Error {
  readonly status = 400
  readonly code = 'CHANNEL_SETTINGS_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'ChannelSettingsValidationError'
  }
}

const ALL_CHANNEL_KEYS = new Set<string>(CHANNEL_PROVIDERS.flatMap((provider) => channelEnvKeys(provider.id)))
const SECRET_SUFFIXES = ['_APP_SECRET', '_WEBHOOK_TOKEN', '_SIGNING_SECRET'] as const

function isSecret(key: string): boolean {
  return SECRET_SUFFIXES.some((suffix) => key.endsWith(suffix))
}

function mask(value: string): string {
  if (!value) return ''
  if (value.length <= 4) return '••••'
  return `${value.slice(0, 2)}••••${value.slice(-2)}`
}

function parseEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}

function validatePatch(patch: Record<string, string>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!ALL_CHANNEL_KEYS.has(key)) throw new ChannelSettingsValidationError(`不支持的渠道配置项：${key}`)
    if (typeof value !== 'string') throw new ChannelSettingsValidationError(`${key} 必须是字符串`)
    if (/[\r\n]/u.test(value)) throw new ChannelSettingsValidationError(`${key} 不能包含换行符`)
    if (key.endsWith('_ENABLED') && !['true', 'false'].includes(value.trim().toLowerCase())) {
      throw new ChannelSettingsValidationError(`${key} 必须是 true 或 false`)
    }
    if (key.endsWith('_BASE_URL') && value.trim()) {
      let parsed: URL
      try {
        parsed = new URL(value.trim())
      } catch {
        throw new ChannelSettingsValidationError(`${key} 必须是合法地址`)
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new ChannelSettingsValidationError(`${key} 只支持 http 或 https`)
      if (parsed.username || parsed.password) throw new ChannelSettingsValidationError(`${key} 不能包含用户名或密码`)
    }
  }
}

export async function readChannelSettings(filePath = resolveEnvFilePath()): Promise<ChannelSettings> {
  const values = await readEnvValues(filePath)
  return Object.fromEntries(CHANNEL_PROVIDERS.map((provider) => {
    const definition = channelProviderDefinition(provider.id)
    const enabled = parseEnabled(values.get(`CHANNEL_${provider.prefix}_ENABLED`))
    const missing = definition.fields
      .filter((item) => item.required && !values.get(item.key)?.trim())
      .map((item) => item.key)
    const providerValues = Object.fromEntries(definition.fields.map((item) => {
      const raw = values.get(item.key) ?? ''
      const secret = item.secret || isSecret(item.key)
      return [item.key, {
        value: secret ? mask(raw) : raw,
        configured: Boolean(raw.trim()),
        masked: secret,
      }]
    })) as Record<string, ChannelEnvSetting>
    return [provider.id, {
      id: provider.id,
      name: provider.name,
      description: provider.description,
      enabled,
      configured: missing.length === 0,
      missing,
      values: providerValues,
      fields: definition.fields,
      capabilities: definition.capabilities,
    }]
  })) as ChannelSettings
}

export async function updateChannelSettings(
  filePath = resolveEnvFilePath(),
  patch: Record<string, string>,
): Promise<ChannelSettings> {
  validatePatch(patch)
  await writeEnvFile(filePath, patch)
  return readChannelSettings(filePath)
}

export async function readChannelConnectionInput(
  filePath: string | undefined,
  provider: ChannelProvider,
): Promise<ChannelConnectionInput> {
  const values = await readEnvValues(filePath ?? resolveEnvFilePath())
  const definition = channelProviderDefinition(provider)
  const value = (connectionKey: string): string => {
    const field = definition.fields.find((item) => item.connectionKey === connectionKey)
    return field ? values.get(field.key)?.trim() ?? '' : ''
  }
  return {
    enabled: value('enabled').toLowerCase() === 'true',
    baseUrl: value('baseUrl'),
    appKey: value('appKey'),
    appSecret: value('appSecret'),
    webhookToken: value('webhookToken'),
    signingSecret: value('signingSecret'),
  }
}
