import type { ChannelConnectionInput, ChannelProvider } from './types.js'

export type ChannelOperationStatus = 'ok' | 'not_configured' | 'not_implemented' | 'error'

export interface ChannelOperationResult {
  status: ChannelOperationStatus
  message: string
}

export interface ChannelWebhookInput {
  body: Buffer
  timestamp: string
  signature: string
  secret: string
  nowMs?: number
}

export interface ChannelWebhookResult {
  ok: boolean
  message: string
}

export interface ChannelPublishJobInput {
  jobId: string
  title: string
  description: string
}

export interface ChannelPullResumesInput {
  cursor?: string
}

export interface ChannelConnector {
  readonly provider: ChannelProvider
  test(input: ChannelConnectionInput): Promise<ChannelOperationResult>
  publishJob(input: ChannelPublishJobInput): Promise<ChannelOperationResult>
  pullResumes(input: ChannelPullResumesInput): Promise<ChannelOperationResult>
  verifyWebhook(input: ChannelWebhookInput): Promise<ChannelWebhookResult>
}

export class ChannelConnectorError extends Error {
  readonly status = 502
  readonly code = 'CHANNEL_CONNECTOR_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'ChannelConnectorError'
  }
}
