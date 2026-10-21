import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AuthSession, RegisterInput, SessionUser, WorkspaceCreateInput, WorkspaceSummary, WorkspaceRole } from './types.js'
import { hashPassword, verifyPassword } from './password.js'

const SESSION_TTL_MS = 1000 * 60 * 60 * 12
const DEFAULT_PATH = resolve(process.cwd(), 'data/auth-sessions.json')
const timestamp = () => new Date().toISOString()

interface StoredWorkspace extends WorkspaceSummary { createdBy: string; updatedAt?: string }
interface SessionFile {
  version: 1
  sessions: AuthSession[]
  users: Array<SessionUser & { passwordHash: string }>
  workspaces?: StoredWorkspace[]
  workspaceMembers?: Array<{ workspaceId: string; userId: string; role: WorkspaceRole }>
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
    workspaces: [],
    workspaceMembers: [],
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
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        users: mergedUsers,
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
        workspaceMembers: Array.isArray(parsed.workspaceMembers) ? parsed.workspaceMembers : [],
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

  async registerUser(input: RegisterInput): Promise<SessionUser> {
    return this.exclusive(async () => {
      const file = await this.readFile()
      const name = input.name.trim()
      const email = input.email.trim().toLowerCase()
      const password = String(input.password)
      if (name.length < 2 || name.length > 80) throw Object.assign(new Error('姓名长度需为 2 到 80 个字符'), { code: 'VALIDATION_ERROR', status: 400 })
      if (!/^\S+@\S+\.\S+$/.test(email)) throw Object.assign(new Error('请输入有效邮箱'), { code: 'VALIDATION_ERROR', status: 400 })
      if (password.length < 8) throw Object.assign(new Error('密码至少需要 8 个字符'), { code: 'VALIDATION_ERROR', status: 400 })
      if (file.users.some((user) => user.email.toLowerCase() === email)) throw Object.assign(new Error('该邮箱已注册，请直接登录'), { code: 'EMAIL_ALREADY_EXISTS', status: 409 })
      const user: SessionUser = { id: randomUUID(), name, email, role: 'recruiter', departmentId: '' }
      file.users.push({ ...user, passwordHash: await hashPassword(password) })
      await this.writeFile(file)
      return user
    })
  }

  async findUserByEmailPassword(email: string, password: string): Promise<SessionUser | undefined> {
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
      return { id: user.id, name: user.name, email: user.email, role: user.role, departmentId: user.departmentId }
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
        return { id: user.id, name: user.name, email: user.email, role: user.role, departmentId: user.departmentId, workspaceId: workspace.id, workspaceName: workspace.name, workspaceKind: workspace.kind }
      }
      session.user = { ...session.user, workspaceId: workspace.id, workspaceName: workspace.name, workspaceKind: workspace.kind }
      await this.writeFile(file)
      return session.user
    })
  }
  async createSession(user: SessionUser, ttlMs = SESSION_TTL_MS): Promise<{ session: AuthSession; token: string }> {
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
