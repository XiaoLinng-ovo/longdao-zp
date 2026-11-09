import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type {
  AuthSession,
  CreateMfaChallengeInput,
  CreateVerificationChallengeInput,
  LoginAttemptReservation,
  MfaChallenge,
  MfaCredential,
  PasswordAuthentication,
  ProfileContact,
  ProfileUpdateInput,
  RegisterInput,
  RegisterResult,
  SessionUser,
  VerificationChallengeCreation,
  VerificationChallengeRecord,
  WorkspaceCreateInput,
  WorkspaceSummary,
  WorkspaceRole,
} from './types.js'
import { hashPassword, verifyPassword } from './password.js'
import { normalizeRegistrationInput } from './registration.js'
import type { NormalizedRegistration } from './registration.js'
import { safeHashEqual } from './verification-code.js'

const SESSION_TTL_MS = 1000 * 60 * 60 * 12
const DEFAULT_PATH = resolve(process.cwd(), 'data/auth-sessions.json')
const timestamp = () => new Date().toISOString()

interface StoredWorkspace extends WorkspaceSummary { createdBy: string; updatedAt?: string }
interface StoredUser extends Omit<SessionUser, 'phone'> { passwordHash: string; phone?: string | null; registrationSource?: string; emailVerifiedAt?: string | null }
interface StoredLoginAttempt { id: string; email: string; ipAddress?: string; succeeded: boolean; failureReason?: string; attemptedAt: string }
interface SessionFile {
  version: 1
  sessions: AuthSession[]
  users: StoredUser[]
  workspaces?: StoredWorkspace[]
  workspaceMembers?: Array<{ workspaceId: string; userId: string; role: WorkspaceRole }>
  registrationAttempts?: Array<{ email: string; attemptedAt: string }>
  emailVerificationChallenges?: VerificationChallengeRecord[]
  loginAttempts?: StoredLoginAttempt[]
  mfaCredentials?: MfaCredential[]
  mfaChallenges?: MfaChallenge[]
}

const DEV_USERS: Array<SessionUser & { password: string }> = [
  {
    id: 'user-admin',
    name: '企业用户',
    email: 'admin@smartrecruit.local',
    role: 'recruiter',
    departmentId: 'dept-admin',
    password: 'admin123',
  },
  {
    id: 'user-recruiter',
    name: '招聘专员',
    email: 'recruiter@smartrecruit.local',
    role: 'recruiter',
    departmentId: 'dept-tech',
    password: 'recruiter123',
  },
  {
    id: 'user-hr-manager',
    name: '部门负责人',
    email: 'manager@smartrecruit.local',
    role: 'recruiter',
    departmentId: 'dept-tech',
    password: 'manager123',
  },
  {
    id: 'user-approver',
    name: '审批人',
    email: 'approver@smartrecruit.local',
    role: 'recruiter',
    departmentId: 'dept-admin',
    password: 'approver123',
  },
  {
    id: 'user-hr-admin',
    name: 'HR 管理员',
    email: 'hr@smartrecruit.local',
    role: 'recruiter',
    departmentId: 'dept-admin',
    password: 'hr123',
  },
  {
    id: 'user-interviewer',
    name: '面试官',
    email: 'interviewer@smartrecruit.local',
    role: 'recruiter',
    departmentId: 'dept-tech',
    password: 'interviewer123',
  },
]

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeLocalUser<T extends { email: string; role: string; platformRole?: SessionUser['platformRole'] }>(user: T): T {
  const { platformRole, ...ordinaryUser } = user
  const authorizedRole = platformRole
  return { ...ordinaryUser, role: 'recruiter', ...(authorizedRole ? { platformRole: authorizedRole } : {}) } as T
}

function createSeedFile(): SessionFile {
  return {
    version: 1,
    sessions: [],
    users: DEV_USERS.map(({ password, ...user }) => ({ ...user, passwordHash: sha256(password) })),
    workspaces: [],
    workspaceMembers: [],
    registrationAttempts: [],
    emailVerificationChallenges: [],
    loginAttempts: [],
    mfaCredentials: [],
    mfaChallenges: [],
  }
}

export class LocalAuthSessionStore {
  private readonly filePath: string
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(filePath = process.env.AUTH_STORE_PATH || DEFAULT_PATH) {
    this.filePath = filePath
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue
    let release!: () => void
    this.operationQueue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async readFile(): Promise<SessionFile> {
    try {
      const content = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(content) as SessionFile
      const seed = createSeedFile()
      const users = Array.isArray(parsed.users) ? parsed.users : seed.users
      const mergedUsers = [...users]
      for (const seedUser of seed.users) {
        if (!mergedUsers.some((item) => item.email.toLowerCase() === seedUser.email.toLowerCase())) mergedUsers.push(seedUser)
      }
      return {
        version: 1,
        sessions: (Array.isArray(parsed.sessions) ? parsed.sessions : []).map(session => ({ ...session, user: normalizeLocalUser(session.user) })),
        users: mergedUsers.map(user => normalizeLocalUser(user)),
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
        workspaceMembers: Array.isArray(parsed.workspaceMembers) ? parsed.workspaceMembers : [],
        registrationAttempts: Array.isArray(parsed.registrationAttempts) ? parsed.registrationAttempts : [],
        emailVerificationChallenges: Array.isArray(parsed.emailVerificationChallenges) ? parsed.emailVerificationChallenges : [],
        loginAttempts: Array.isArray(parsed.loginAttempts) ? parsed.loginAttempts : [],
        mfaCredentials: Array.isArray(parsed.mfaCredentials) ? parsed.mfaCredentials : [],
        mfaChallenges: Array.isArray(parsed.mfaChallenges) ? parsed.mfaChallenges : [],
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createSeedFile()
      throw error
    }
  }

  private async writeFile(data: SessionFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), 'utf8')
    await rename(temporaryPath, this.filePath)
  }

  private issueToken(): { token: string; tokenHash: string } {
    const token = randomBytes(32).toString('base64url')
    return { token, tokenHash: sha256(token) }
  }

  private async createRegisteredEntities(file: SessionFile, data: NormalizedRegistration, emailVerifiedAt: string): Promise<RegisterResult> {
    if (file.users.some((user) => user.email.toLowerCase() === data.email)) {
      throw Object.assign(new Error('该邮箱已注册，请直接登录'), { code: 'EMAIL_ALREADY_EXISTS', status: 409 })
    }
    const now = timestamp()
    const workspace: StoredWorkspace = {
      id: randomUUID(),
      name: data.companyName,
      kind: 'production',
      status: 'active',
      role: 'owner',
      createdAt: now,
      createdBy: '',
      serviceStatus: 'trial',
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      serviceAvailable: true,
    }
    const user: SessionUser = {
      id: randomUUID(),
      name: data.name,
      email: data.email,
      role: 'recruiter',
      departmentId: '',
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceKind: workspace.kind,
    }
    workspace.createdBy = user.id
    file.users.push({
      ...user,
      phone: data.phone,
      registrationSource: 'open_registration',
      passwordHash: await hashPassword(data.password),
      emailVerifiedAt,
    })
    file.workspaces = file.workspaces ?? []
    file.workspaceMembers = file.workspaceMembers ?? []
    file.workspaces.push(workspace)
    file.workspaceMembers.push({ workspaceId: workspace.id, userId: user.id, role: 'owner' })
    return {
      user,
      workspace: {
        id: workspace.id,
        name: workspace.name,
        kind: workspace.kind,
        status: workspace.status,
        role: 'owner',
        createdAt: workspace.createdAt,
        serviceStatus: workspace.serviceStatus ?? 'trial',
        trialEndsAt: workspace.trialEndsAt ?? null,
        serviceAvailable: true,
      },
    }
  }

  private async verifyAndConsumeChallenge(
    file: SessionFile,
    purpose: VerificationChallengeRecord['purpose'],
    email: string,
    codeHash: string,
  ): Promise<VerificationChallengeRecord> {
    const now = Date.now()
    const challenge = [...(file.emailVerificationChallenges ?? [])]
      .reverse()
      .find((item) => item.purpose === purpose && item.email.toLowerCase() === email && !item.consumedAt && !item.invalidatedAt)
    const invalid = () => Object.assign(new Error('验证码无效或已过期，请重新获取'), { code: 'INVALID_VERIFICATION_CODE', status: 400 })
    if (!challenge) throw invalid()
    if (Date.parse(challenge.expiresAt) <= now) {
      challenge.invalidatedAt = timestamp()
      await this.writeFile(file)
      throw invalid()
    }
    if (!safeHashEqual(codeHash, challenge.codeHash)) {
      challenge.attempts += 1
      if (challenge.attempts >= challenge.maxAttempts) challenge.invalidatedAt = timestamp()
      await this.writeFile(file)
      throw invalid()
    }
    challenge.consumedAt = timestamp()
    return challenge
  }

  async hasUserByEmail(email: string): Promise<boolean> {
    return this.exclusive(async () => {
      const normalized = email.trim().toLowerCase()
      return (await this.readFile()).users.some((user) => user.email.toLowerCase() === normalized)
    })
  }

  async findUserById(userId: string): Promise<SessionUser | undefined> {
    return this.exclusive(async () => {
      const user = (await this.readFile()).users.find((item) => item.id === userId)
      return user ? {
        id: user.id,
        ...(user.userNo ? { userNo: user.userNo } : {}),
        name: user.name,
        email: user.email,
        ...(user.phone ? { phone: user.phone } : {}),
        role: user.role,
        departmentId: user.departmentId,
        ...(user.platformRole ? { platformRole: user.platformRole } : {}),
      } : undefined
    })
  }

  async updateUserProfile(userId: string, input: ProfileUpdateInput): Promise<ProfileContact> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      const user = file.users.find((item) => item.id === userId)
      if (!user) throw Object.assign(new Error('账号不存在或已停用'), { code: 'PROFILE_NOT_FOUND', status: 404 })

      if (input.name !== undefined) user.name = input.name
      if (input.phone !== undefined) user.phone = input.phone || null

      for (const session of file.sessions) {
        if (session.userId !== userId) continue
        const { phone: _previousPhone, ...sessionUser } = session.user
        session.user = {
          ...sessionUser,
          name: user.name,
          ...(user.phone ? { phone: user.phone } : {}),
        }
      }

      await this.writeFile(file)
      return {
        name: user.name,
        ...(user.phone ? { phone: user.phone } : {}),
      }
    })
  }

  async createEmailVerificationChallenge(input: CreateVerificationChallengeInput): Promise<VerificationChallengeCreation> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      const now = Date.now()
      const email = input.email.trim().toLowerCase()
      const challenges = file.emailVerificationChallenges ?? []
      const latest = challenges.filter((item) => item.purpose === input.purpose && item.email.toLowerCase() === email).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
      const retryAfter = latest ? Math.max(1, Math.ceil((Date.parse(latest.createdAt) + 60_000 - now) / 1000)) : 0
      if (latest && Date.parse(latest.createdAt) > now - 60_000) return { retryAfterSeconds: retryAfter }
      const emailHourly = challenges.filter((item) => item.purpose === input.purpose && item.email.toLowerCase() === email && Date.parse(item.createdAt) > now - 60 * 60_000).length
      const emailDaily = challenges.filter((item) => item.purpose === input.purpose && item.email.toLowerCase() === email && Date.parse(item.createdAt) > now - 24 * 60 * 60_000).length
      const ipHourly = input.requestIp ? challenges.filter((item) => item.requestIp === input.requestIp && Date.parse(item.createdAt) > now - 60 * 60_000).length : 0
      if (emailHourly >= 5 || emailDaily >= 15 || ipHourly >= 20) return { retryAfterSeconds: 60 }
      for (const item of challenges) {
        if (item.purpose === input.purpose && item.email.toLowerCase() === email && !item.consumedAt && !item.invalidatedAt) item.invalidatedAt = timestamp()
      }
      const createdAt = timestamp()
      const challenge: VerificationChallengeRecord = {
        id: randomUUID(),
        purpose: input.purpose,
        email,
        codeHash: input.codeHash,
        expiresAt: new Date(now + input.expiresInMs).toISOString(),
        attempts: 0,
        maxAttempts: input.maxAttempts,
        ...(input.requestIp ? { requestIp: input.requestIp } : {}),
        createdAt,
      }
      file.emailVerificationChallenges = [...challenges, challenge]
      await this.writeFile(file)
      return { challenge, retryAfterSeconds: 60 }
    })
  }

  async invalidateVerificationChallenge(id: string): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile()
      const challenge = (file.emailVerificationChallenges ?? []).find((item) => item.id === id)
      if (!challenge || challenge.consumedAt) return
      challenge.invalidatedAt = timestamp()
      await this.writeFile(file)
    })
  }

  async registerUserWithVerification(input: RegisterInput, verification: { codeHash: string; verifiedAt?: string }): Promise<RegisterResult> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      const data = normalizeRegistrationInput(input)
      await this.verifyAndConsumeChallenge(file, 'registration', data.email, verification.codeHash)
      const result = await this.createRegisteredEntities(file, data, verification.verifiedAt ?? timestamp())
      file.registrationAttempts = [...(file.registrationAttempts ?? []), { email: data.email, attemptedAt: timestamp() }]
      await this.writeFile(file)
      return result
    })
  }

  async resetPasswordWithVerification(input: { email: string; codeHash: string; passwordHash: string }): Promise<void> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      const email = input.email.trim().toLowerCase()
      const user = file.users.find((item) => item.email.toLowerCase() === email)
      if (!user) {
        const fakeHash = input.codeHash
        await this.verifyAndConsumeChallenge(file, 'password_reset', email, fakeHash)
        throw Object.assign(new Error('验证码无效或已过期，请重新获取'), { code: 'INVALID_VERIFICATION_CODE', status: 400 })
      }
      await this.verifyAndConsumeChallenge(file, 'password_reset', email, input.codeHash)
      user.passwordHash = input.passwordHash
      file.sessions = file.sessions.filter((session) => session.userId !== user.id)
      file.mfaCredentials = (file.mfaCredentials ?? []).filter((credential) => credential.userId !== user.id)
      file.mfaChallenges = (file.mfaChallenges ?? []).filter((challenge) => challenge.userId !== user.id || challenge.consumedAt || challenge.invalidatedAt)
      await this.writeFile(file)
    })
  }

  async startLoginAttempt(input: { email: string; ipAddress?: string; windowMs?: number; emailLimit?: number; ipLimit?: number }): Promise<LoginAttemptReservation> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      const now = Date.now()
      const windowMs = input.windowMs ?? 15 * 60_000
      const thresholdTime = now - windowMs
      const email = input.email.trim().toLowerCase()
      file.loginAttempts = (file.loginAttempts ?? []).filter((item) => Date.parse(item.attemptedAt) > now - 24 * 60 * 60_000)
      const emailFailures = file.loginAttempts.filter((item) => item.email.toLowerCase() === email && !item.succeeded && Date.parse(item.attemptedAt) > thresholdTime)
      const ipFailures = input.ipAddress ? file.loginAttempts.filter((item) => item.ipAddress === input.ipAddress && !item.succeeded && Date.parse(item.attemptedAt) > thresholdTime) : []
      if (emailFailures.length >= (input.emailLimit ?? 5) || ipFailures.length >= (input.ipLimit ?? 30)) {
        const oldest = [...emailFailures, ...ipFailures].sort((a, b) => Date.parse(a.attemptedAt) - Date.parse(b.attemptedAt))[0]
        return { id: '', allowed: false, retryAfterSeconds: oldest ? Math.max(1, Math.ceil((Date.parse(oldest.attemptedAt) + windowMs - now) / 1000)) : 60 }
      }
      const attempt: StoredLoginAttempt = { id: randomUUID(), email, ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}), succeeded: false, attemptedAt: timestamp() }
      file.loginAttempts.push(attempt)
      await this.writeFile(file)
      return { id: attempt.id, allowed: true, retryAfterSeconds: 0 }
    })
  }

  async finishLoginAttempt(id: string, succeeded: boolean, failureReason?: string): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile()
      const attempt = (file.loginAttempts ?? []).find((item) => item.id === id)
      if (!attempt) return
      attempt.succeeded = succeeded
      if (failureReason) attempt.failureReason = failureReason
      if (succeeded) {
        for (const item of file.loginAttempts ?? []) {
          if (item.email.toLowerCase() === attempt.email.toLowerCase() && Date.parse(item.attemptedAt) > Date.now() - 15 * 60_000) item.succeeded = true
        }
      }
      await this.writeFile(file)
    })
  }

  async registerUser(input: RegisterInput): Promise<RegisterResult> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      const data = normalizeRegistrationInput(input)
      const recent = (file.registrationAttempts ?? []).filter((item) => item.email === data.email && Date.parse(item.attemptedAt) > Date.now() - 60 * 60 * 1000)
      if (recent.length >= 3) throw Object.assign(new Error('注册尝试过于频繁，请稍后再试'), { code: 'REGISTRATION_RATE_LIMITED', status: 429 })
      file.registrationAttempts = [...(file.registrationAttempts ?? []), { email: data.email, attemptedAt: timestamp() }]
      if (file.users.some((user) => user.email.toLowerCase() === data.email)) {
        await this.writeFile(file)
        throw Object.assign(new Error('该邮箱已注册，请直接登录'), { code: 'EMAIL_ALREADY_EXISTS', status: 409 })
      }
      const now = timestamp()
      const user: SessionUser = { id: randomUUID(), name: data.name, email: data.email, role: 'recruiter', departmentId: '' }
      const workspace: StoredWorkspace = {
        id: randomUUID(),
        name: data.companyName,
        kind: 'production',
        status: 'active',
        role: 'owner',
        createdAt: now,
        createdBy: user.id,
        serviceStatus: 'trial',
        trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        serviceAvailable: true,
      }
      file.users.push({ ...user, phone: data.phone, registrationSource: 'open_registration', passwordHash: await hashPassword(data.password) })
      file.workspaces = file.workspaces ?? []
      file.workspaceMembers = file.workspaceMembers ?? []
      file.workspaces.push(workspace)
      file.workspaceMembers.push({ workspaceId: workspace.id, userId: user.id, role: 'owner' })
      await this.writeFile(file)
      return {
        user,
        workspace: {
          id: workspace.id,
          name: workspace.name,
          kind: workspace.kind,
          status: workspace.status,
          role: 'owner',
          createdAt: workspace.createdAt,
          serviceStatus: workspace.serviceStatus ?? 'trial',
          trialEndsAt: workspace.trialEndsAt ?? null,
          serviceAvailable: true,
        },
      }
    })
  }

  async findUserByEmailPassword(email: string, password: string): Promise<SessionUser | undefined> {
    return (await this.findUserForPasswordAuthentication(email, password))?.user
  }

  async findUserForPasswordAuthentication(email: string, password: string): Promise<PasswordAuthentication | undefined> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      const normalizedEmail = email.trim().toLowerCase()
      const user = file.users.find((item) => item.email.toLowerCase() === normalizedEmail)
      if (!user) return undefined
      const encoded = user.passwordHash
      const isScrypt = encoded.startsWith('scrypt$')
      const valid = isScrypt ? await verifyPassword(password, encoded) : encoded === sha256(password)
      if (!valid) return undefined
      if (!isScrypt) {
        user.passwordHash = await hashPassword(password)
        await this.writeFile(file)
      }
      return {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          ...(user.phone ? { phone: user.phone } : {}),
          role: user.role,
          departmentId: user.departmentId,
        },
        mfaEnabled: (file.mfaCredentials ?? []).some((item) => item.userId === user.id),
      }
    })
  }

  async getMfaCredential(userId: string): Promise<MfaCredential | undefined> {
    return this.exclusive(async () => {
      const credential = (await this.readFile()).mfaCredentials?.find((item) => item.userId === userId)
      return credential ? { ...credential, recoveryCodeHashes: [...credential.recoveryCodeHashes] } : undefined
    })
  }

  async createMfaChallenge(input: CreateMfaChallengeInput): Promise<MfaChallenge> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      const now = Date.now()
      file.mfaChallenges = (file.mfaChallenges ?? []).filter((item) => Date.parse(item.expiresAt) > now - 24 * 60 * 60_000)
      const challenge: MfaChallenge = {
        id: randomUUID(),
        tokenHash: input.tokenHash,
        userId: input.userId,
        ...(input.loginAttemptId ? { loginAttemptId: input.loginAttemptId } : {}),
        kind: input.kind,
        ...(input.encryptedSecret ? { encryptedSecret: input.encryptedSecret } : {}),
        expiresAt: new Date(now + input.expiresInMs).toISOString(),
        attempts: 0,
        maxAttempts: input.maxAttempts,
        ...(input.requestIp ? { requestIp: input.requestIp } : {}),
        createdAt: timestamp(),
      }
      file.mfaChallenges.push(challenge)
      await this.writeFile(file)
      return challenge
    })
  }

  async findMfaChallengeByTokenHash(tokenHash: string): Promise<MfaChallenge | undefined> {
    return this.exclusive(async () => {
      return (await this.readFile()).mfaChallenges?.find((item) =>
        item.tokenHash === tokenHash && !item.consumedAt && !item.invalidatedAt && Date.parse(item.expiresAt) > Date.now(),
      )
    })
  }

  async recordMfaChallengeFailure(id: string): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile()
      const challenge = (file.mfaChallenges ?? []).find((item) => item.id === id && !item.consumedAt && !item.invalidatedAt)
      if (!challenge) return
      challenge.attempts += 1
      if (challenge.attempts >= challenge.maxAttempts) challenge.invalidatedAt = timestamp()
      await this.writeFile(file)
    })
  }

  async completeMfaChallenge(id: string, credential: MfaCredential): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile()
      const challenge = (file.mfaChallenges ?? []).find((item) =>
        item.id === id && !item.consumedAt && !item.invalidatedAt && Date.parse(item.expiresAt) > Date.now(),
      )
      if (!challenge) throw Object.assign(new Error('MFA 验证已失效，请重新登录'), { code: 'MFA_CHALLENGE_EXPIRED', status: 401 })
      const credentials = file.mfaCredentials ?? []
      const existing = credentials.find((item) => item.userId === challenge.userId)
      if (challenge.kind === 'setup' && existing) {
        throw Object.assign(new Error('该账号已启用 MFA'), { code: 'MFA_ALREADY_ENABLED', status: 409 })
      }
      if (challenge.kind === 'login') {
        if (!existing) throw Object.assign(new Error('MFA 凭据不存在'), { code: 'INVALID_MFA_CODE', status: 401 })
        const replayedTotp = credential.lastUsedStep !== undefined && existing.lastUsedStep !== undefined && credential.lastUsedStep <= existing.lastUsedStep
        const replayedRecovery = credential.lastUsedStep === undefined && credential.recoveryCodeHashes.length >= existing.recoveryCodeHashes.length
        if (replayedTotp || replayedRecovery) {
          throw Object.assign(new Error('动态验证码已使用，请等待下一个验证码'), { code: 'MFA_CODE_REPLAYED', status: 401 })
        }
        Object.assign(existing, credential, { recoveryCodeHashes: [...credential.recoveryCodeHashes] })
      } else {
        credentials.push({ ...credential, recoveryCodeHashes: [...credential.recoveryCodeHashes] })
        file.mfaCredentials = credentials
      }
      challenge.consumedAt = timestamp()
      await this.writeFile(file)
    })
  }

  async invalidateMfaChallenge(id: string): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile()
      const challenge = (file.mfaChallenges ?? []).find((item) => item.id === id)
      if (!challenge || challenge.consumedAt) return
      challenge.invalidatedAt = timestamp()
      await this.writeFile(file)
    })
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile()
      file.sessions = file.sessions.filter((session) => session.userId !== userId)
      await this.writeFile(file)
    })
  }


  async listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      const memberships = (file.workspaceMembers ?? []).filter((item) => item.userId === userId)
      return memberships.flatMap((membership) => {
        const workspace = (file.workspaces ?? []).find((item) => item.id === membership.workspaceId)
        if (!workspace) return []
        return [{ id: workspace.id, name: workspace.name, kind: workspace.kind, status: workspace.status, role: membership.role, createdAt: workspace.createdAt, ...(workspace.archivedAt ? { archivedAt: workspace.archivedAt } : {}) }]
      })
    })
  }

  async createWorkspace(userId: string, input: WorkspaceCreateInput): Promise<WorkspaceSummary> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      if (!['test', 'production'].includes(input.kind)) throw Object.assign(new Error('企业类型只能是测试企业或正式企业'), { code: 'VALIDATION_ERROR', status: 400 })
      const name = input.name.trim()
      if (name.length < 2 || name.length > 120) throw Object.assign(new Error('企业名称长度需为 2 到 120 个字符'), { code: 'VALIDATION_ERROR', status: 400 })
      const now = timestamp()
      const workspace: StoredWorkspace = { id: randomUUID(), name, kind: input.kind, status: 'active', role: 'owner', createdAt: now, createdBy: userId }
      file.workspaces = file.workspaces ?? []
      file.workspaceMembers = file.workspaceMembers ?? []
      file.workspaces.push(workspace)
      file.workspaceMembers.push({ workspaceId: workspace.id, userId, role: 'owner' })
      await this.writeFile(file)
      return { id: workspace.id, name: workspace.name, kind: workspace.kind, status: workspace.status, role: 'owner', createdAt: workspace.createdAt }
    })
  }

  async archiveWorkspace(userId: string, workspaceId: string): Promise<void> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      const membership = (file.workspaceMembers ?? []).find((item) => item.userId === userId && item.workspaceId === workspaceId && item.role === 'owner')
      const workspace = (file.workspaces ?? []).find((item) => item.id === workspaceId)
      if (!membership || !workspace) throw Object.assign(new Error('无权操作该企业'), { code: 'FORBIDDEN', status: 403 })
      if (workspace.status === 'archived') return
      workspace.status = 'archived'; workspace.archivedAt = timestamp()
      for (const session of file.sessions) {
        if (session.user.workspaceId !== workspaceId) continue
        const { workspaceId: _workspaceId, workspaceName: _workspaceName, workspaceKind: _workspaceKind, ...user } = session.user
        session.user = user
      }
      await this.writeFile(file)
    })
  }

  async resetWorkspace(userId: string, workspaceId: string): Promise<void> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      const membership = (file.workspaceMembers ?? []).find((item) => item.userId === userId && item.workspaceId === workspaceId && item.role === 'owner')
      const workspace = (file.workspaces ?? []).find((item) => item.id === workspaceId)
      if (!membership || !workspace) throw Object.assign(new Error('无权操作该企业'), { code: 'FORBIDDEN', status: 403 })
      if (workspace.status !== 'active') throw Object.assign(new Error('已归档的企业不能重置'), { code: 'WORKSPACE_ARCHIVED', status: 400 })
      if (workspace.kind !== 'test') throw Object.assign(new Error('只有测试企业可以重新开始'), { code: 'TEST_WORKSPACE_REQUIRED', status: 400 })
      workspace.updatedAt = timestamp()
      await this.writeFile(file)
    })
  }

  async selectWorkspace(sessionId: string, userId: string, workspaceId: string): Promise<SessionUser> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      const membership = (file.workspaceMembers ?? []).find((item) => item.userId === userId && item.workspaceId === workspaceId)
      const workspace = (file.workspaces ?? []).find((item) => item.id === workspaceId && item.status === 'active')
      if (!membership || !workspace) throw Object.assign(new Error('无权访问该企业'), { code: 'FORBIDDEN', status: 403 })
      const session = file.sessions.find((item) => item.sessionId === sessionId && item.userId === userId)
      if (!session) {
        if (sessionId !== 'development-bootstrap') throw Object.assign(new Error('登录状态已失效'), { code: 'AUTHENTICATION_REQUIRED', status: 401 })
        const user = file.users.find((item) => item.id === userId)
        if (!user) throw Object.assign(new Error('登录状态已失效'), { code: 'AUTHENTICATION_REQUIRED', status: 401 })
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          ...(user.phone ? { phone: user.phone } : {}),
          role: user.role,
          departmentId: user.departmentId,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceKind: workspace.kind,
        }
      }
      session.user = { ...session.user, workspaceId: workspace.id, workspaceName: workspace.name, workspaceKind: workspace.kind }
      await this.writeFile(file)
      return session.user
    })
  }
  async createSession(
    user: SessionUser,
    ttlMs = SESSION_TTL_MS,
    _metadata: { userAgent?: string; ipAddress?: string } = {},
  ): Promise<{ session: AuthSession; token: string }> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      const now = Date.now()
      file.sessions = file.sessions.filter((session) => new Date(session.expiresAt).getTime() > now)
      const { token, tokenHash } = this.issueToken()
      const session: AuthSession = {
        sessionId: randomUUID(), userId: user.id, tokenHash, createdAt: timestamp(),
        expiresAt: new Date(now + ttlMs).toISOString(), lastSeenAt: timestamp(), user,
      }
      file.sessions.push(session)
      await this.writeFile(file)
      return { session, token }
    })
  }

  async findSessionByToken(token: string): Promise<AuthSession | undefined> {
    if (!token) return undefined
    return this.exclusive(async () => {
      const file = await this.readFile()
      const tokenHash = sha256(token)
      const session = file.sessions.find((item) => item.tokenHash === tokenHash)
      if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return undefined
      session.lastSeenAt = timestamp()
      await this.writeFile(file)
      return session
    })
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile()
      file.sessions = file.sessions.filter((session) => session.sessionId !== sessionId)
      await this.writeFile(file)
    })
  }

  async listSessions(): Promise<AuthSession[]> {
    return this.exclusive(async () => (await this.readFile()).sessions)
  }
}
