import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AuthSession, SessionUser } from './types.js'

const SESSION_TTL_MS = 1000 * 60 * 60 * 12
const DEFAULT_PATH = resolve(process.cwd(), 'data/auth-sessions.json')
const timestamp = () => new Date().toISOString()

interface SessionFile {
  version: 1
  sessions: AuthSession[]
  users: Array<SessionUser & { passwordHash: string }>
}

const DEV_USERS: Array<SessionUser & { password: string }> = [
  {
    id: 'user-admin',
    name: '系统管理员',
    email: 'admin@smartrecruit.local',
    role: 'admin',
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
    role: 'hiring_manager',
    departmentId: 'dept-tech',
    password: 'manager123',
  },
  {
    id: 'user-approver',
    name: '审批人',
    email: 'approver@smartrecruit.local',
    role: 'approver',
    departmentId: 'dept-admin',
    password: 'approver123',
  },
  {
    id: 'user-hr-admin',
    name: 'HR 管理员',
    email: 'hr@smartrecruit.local',
    role: 'hr_admin',
    departmentId: 'dept-admin',
    password: 'hr123',
  },
  {
    id: 'user-interviewer',
    name: '面试官',
    email: 'interviewer@smartrecruit.local',
    role: 'interviewer',
    departmentId: 'dept-tech',
    password: 'interviewer123',
  },
]

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function createSeedFile(): SessionFile {
  return {
    version: 1,
    sessions: [],
    users: DEV_USERS.map(({ password, ...user }) => ({ ...user, passwordHash: sha256(password) })),
  }
}

export class LocalAuthSessionStore {
  private readonly filePath: string

  constructor(filePath = process.env.AUTH_STORE_PATH || DEFAULT_PATH) {
    this.filePath = filePath
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
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        users: mergedUsers,
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

  async findUserByEmailPassword(email: string, password: string): Promise<SessionUser | undefined> {
    const file = await this.readFile()
    const normalizedEmail = email.trim().toLowerCase()
    const user = file.users.find((item) => item.email.toLowerCase() === normalizedEmail && item.passwordHash === sha256(password))
    return user ? { id: user.id, name: user.name, email: user.email, role: user.role, departmentId: user.departmentId } : undefined
  }

  async createSession(user: SessionUser, ttlMs = SESSION_TTL_MS): Promise<{ session: AuthSession; token: string }> {
    const file = await this.readFile()
    const now = Date.now()
    file.sessions = file.sessions.filter((session) => new Date(session.expiresAt).getTime() > now)
    const { token, tokenHash } = this.issueToken()
    const session: AuthSession = {
      sessionId: randomUUID(),
      userId: user.id,
      tokenHash,
      createdAt: timestamp(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      lastSeenAt: timestamp(),
      user,
    }
    file.sessions.push(session)
    await this.writeFile(file)
    return { session, token }
  }

  async findSessionByToken(token: string): Promise<AuthSession | undefined> {
    if (!token) return undefined
    const file = await this.readFile()
    const tokenHash = sha256(token)
    const session = file.sessions.find((item) => item.tokenHash === tokenHash)
    if (!session) return undefined
    if (new Date(session.expiresAt).getTime() <= Date.now()) return undefined
    session.lastSeenAt = timestamp()
    await this.writeFile(file)
    return session
  }

  async deleteSession(sessionId: string): Promise<void> {
    const file = await this.readFile()
    file.sessions = file.sessions.filter((session) => session.sessionId !== sessionId)
    await this.writeFile(file)
  }

  async listSessions(): Promise<AuthSession[]> {
    const file = await this.readFile()
    return file.sessions
  }
}
