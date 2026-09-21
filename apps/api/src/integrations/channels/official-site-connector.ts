import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  ChannelConnector,
  ChannelOperationResult,
  ChannelPublishJobInput,
  ChannelPullResumesInput,
  ChannelWebhookInput,
  ChannelWebhookResult,
} from './connector.js'
import type { ChannelConnectionInput } from './types.js'

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

export function signOfficialSiteWebhook(secret: string, timestamp: string, body: Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')
}

function equalSignature(expected: string, actual: string): boolean {
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class OfficialSiteConnector implements ChannelConnector {
  readonly provider = 'official_site' as const

  async test(input: ChannelConnectionInput): Promise<ChannelOperationResult> {
    if (!input.enabled) return { status: 'not_configured', message: '公司官网渠道尚未启用' }
    const missing = [
      ...(input.webhookToken.trim() ? [] : ['CHANNEL_OFFICIAL_SITE_WEBHOOK_TOKEN']),
      ...(input.signingSecret.trim() ? [] : ['CHANNEL_OFFICIAL_SITE_SIGNING_SECRET']),
    ]
    if (missing.length) return { status: 'not_configured', message: `缺少配置：${missing.join('、')}` }
    return { status: 'ok', message: '公司官网 Webhook 配置完整' }
  }

  async publishJob(_input: ChannelPublishJobInput): Promise<ChannelOperationResult> {
    return { status: 'not_implemented', message: '公司官网岗位同步接口尚未启用' }
  }

  async pullResumes(_input: ChannelPullResumesInput): Promise<ChannelOperationResult> {
    return { status: 'not_implemented', message: '公司官网使用 Webhook 接收简历，不支持主动拉取' }
  }

  async verifyWebhook(input: ChannelWebhookInput): Promise<ChannelWebhookResult> {
    if (!input.secret) return { ok: false, message: '官网回调签名密钥未配置' }
    if (!/^\d+$/u.test(input.timestamp)) return { ok: false, message: '回调时间戳无效' }
    const timestampMs = Number(input.timestamp) * 1000
    const nowMs = input.nowMs ?? Date.now()
    if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > MAX_CLOCK_SKEW_MS) {
      return { ok: false, message: '回调时间戳已过期' }
    }
    if (!/^[a-f0-9]{64}$/iu.test(input.signature)) return { ok: false, message: '回调签名格式无效' }
    const expected = signOfficialSiteWebhook(input.secret, input.timestamp, input.body)
    return equalSignature(expected, input.signature.toLowerCase())
      ? { ok: true, message: '回调验签通过' }
      : { ok: false, message: '回调签名不匹配' }
  }
}
