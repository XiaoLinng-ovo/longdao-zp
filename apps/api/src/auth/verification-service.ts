import { sendSmtpMail } from '../integrations/email/smtp.js'
import type { CreateVerificationChallengeInput, VerificationChallengeCreation, VerificationPurpose } from './types.js'
import { assertVerificationSecret, generateVerificationCode, hashVerificationCode, normalizeVerificationEmail } from './verification-code.js'

export interface VerificationServiceStore {
  hasUserByEmail(email: string): Promise<boolean>
  createEmailVerificationChallenge(input: CreateVerificationChallengeInput): Promise<VerificationChallengeCreation>
  invalidateVerificationChallenge(id: string): Promise<void>
  markVerificationChallengeDelivered(id: string): Promise<void>
}

export interface VerificationMailer {
  send(input: { to: string; subject: string; markdown: string }): Promise<void>
}

const smtpMailer: VerificationMailer = {
  send: (input) => sendSmtpMail(input),
}

export class EmailVerificationService {
  constructor(
    private readonly store: VerificationServiceStore,
    private readonly mailer: VerificationMailer = smtpMailer,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async requestCode(input: {
    email: string
    requestIp?: string
    requireDelivery?: boolean
  } & ({ purpose: Exclude<VerificationPurpose, 'email_change'> } | { purpose: 'email_change'; userId: string })): Promise<{ accepted: true; retryAfterSeconds: number }> {
    const email = normalizeVerificationEmail(input.email)
    assertVerificationSecret(this.env)
    const code = generateVerificationCode()
    const userId = input.purpose === 'email_change' ? input.userId : undefined
    const codeHash = hashVerificationCode(input.purpose, email, code, this.env.AUTH_OTP_HMAC_SECRET, userId)
    const challenge = await this.store.createEmailVerificationChallenge({
      purpose: input.purpose,
      email,
      codeHash,
      ...(userId ? { userId } : {}),
      ...(input.requestIp ? { requestIp: input.requestIp } : {}),
      expiresInMs: 10 * 60_000,
      maxAttempts: 5,
    })
    if (!challenge.challenge) {
      if (userId || input.requireDelivery) throw Object.assign(new Error(`验证码发送过于频繁，请 ${challenge.retryAfterSeconds} 秒后再试`), { code: 'VERIFICATION_RATE_LIMITED', status: 429 })
      return { accepted: true, retryAfterSeconds: challenge.retryAfterSeconds }
    }

    const accountAllowed = input.purpose === 'registration'
      ? !(await this.store.hasUserByEmail(email))
      : input.purpose === 'email_change' || await this.store.hasUserByEmail(email)
    if (!accountAllowed) return { accepted: true, retryAfterSeconds: challenge.retryAfterSeconds }

    try {
      await this.mailer.send({
        to: email,
        subject: input.purpose === 'email_change' ? '智能招聘平台更换邮箱验证码' : input.purpose === 'registration' ? '智能招聘平台注册验证码' : '智能招聘平台密码重置验证码',
        markdown: [
          `你的验证码是：**${code}**`,
          '',
          '验证码 10 分钟内有效，仅可使用一次。若非本人操作，请忽略此邮件。',
          '请勿向任何人透露此验证码。',
        ].join('\n'),
      })
      if (userId || input.requireDelivery) await this.store.markVerificationChallengeDelivered(challenge.challenge.id)
    } catch (error) {
      await this.store.invalidateVerificationChallenge(challenge.challenge.id)
      if (userId || input.requireDelivery) throw Object.assign(new Error('验证码发送失败，请稍后重试或联系管理员检查邮件配置'), { code: 'VERIFICATION_MAIL_UNAVAILABLE', status: 503 })
      throw error
    }
    return { accepted: true, retryAfterSeconds: challenge.retryAfterSeconds }
  }
}
