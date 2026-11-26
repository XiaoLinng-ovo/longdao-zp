import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { HttpError } from '../http.js'
export type SimulationChannel = 'mock_alipay' | 'mock_wechat'
export type SimulationEventKind = 'success' | 'failure' | 'refund' | 'expire' | 'cancel'
export interface SimulationPaymentEvent {
 eventId: string; orderId: string; organizationId: string; channel: SimulationChannel
 kind: SimulationEventKind; transactionId: string; amountFen: number; currency: string; merchant: string; reason: string
}
export interface PaymentNotificationAdapter<T> { readonly mode: 'simulation' | 'live'; verify(body: string, signature: string): T }
/** INTERNAL simulation protocol, NOT Alipay/WeChat's signature format. No public callback exists. */
export class MockPaymentAdapter implements PaymentNotificationAdapter<SimulationPaymentEvent> {
 readonly mode = 'simulation' as const
 constructor(private readonly secret: Buffer = randomBytes(32)) {}
 sign(event: SimulationPaymentEvent): { body: string; signature: string } {
  const body = JSON.stringify(event)
  return {body, signature: createHmac('sha256', this.secret).update(body).digest('hex')}
 }
 verify(body: string, signature: string): SimulationPaymentEvent {
  if (!/^[a-f0-9]{64}$/.test(signature)) throw new HttpError(400,'MOCK_SIGNATURE_INVALID','模拟通知签名无效')
  const expected = createHmac('sha256', this.secret).update(body).digest()
  if (!timingSafeEqual(expected, Buffer.from(signature,'hex'))) throw new HttpError(400,'MOCK_SIGNATURE_INVALID','模拟通知签名无效')
  let event: SimulationPaymentEvent
  try { event = JSON.parse(body) } catch { throw new HttpError(400,'MOCK_EVENT_INVALID','模拟通知格式无效') }
  if (!event || typeof event !== 'object' || !['success','failure','refund','expire','cancel'].includes(event.kind) ||
   !['mock_alipay','mock_wechat'].includes(event.channel) || !Number.isSafeInteger(event.amountFen) || event.amountFen <= 0 ||
   ![event.eventId,event.orderId,event.organizationId,event.transactionId,event.currency,event.merchant,event.reason].every(x=>typeof x==='string'))
   throw new HttpError(400,'MOCK_EVENT_INVALID','模拟通知字段无效')
  return event
 }
}
export function requireSimulationChannel(channel: unknown): SimulationChannel {
 if (channel !== 'mock_alipay' && channel !== 'mock_wechat') throw new HttpError(400,'LIVE_PAYMENT_DISABLED','真实支付宝/微信支付尚未接入，仅支持模拟场景')
 return channel
}
