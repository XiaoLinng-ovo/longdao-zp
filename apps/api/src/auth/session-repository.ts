import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type {
  AccountCredentialChange,
  AccountSessionIdentity,
  AuthSession,
  CreateMfaChallengeInput,
  CreateVerificationChallengeInput,
  LoginAttemptReservation,
  MfaChallenge,
  MfaCredential,
  PasswordAuthentication,
  PasswordResetCompletion,
  ProfileContact,
  ProfileUpdateInput,
  RegisterInput,
  RegisterResult,
  SessionUser,
  SessionIssuanceMetadata,
  VerificationChallengeCreation,
  VerificationChallengeRecord,
  WorkspaceCreateInput,
  WorkspaceSummary,
} from './types.js'
import { hashPassword, verifyPassword } from './password.js'
import { normalizeRegistrationInput } from './registration.js'
import { safeHashEqual } from './verification-code.js'
import { organizationSchemaName } from '../db/tenant-context.js'

export interface SessionRepository {
  findUserByEmailPassword(email: string, password: string): Promise<SessionUser | undefined>
  findUserById(userId: string): Promise<SessionUser | undefined>
  updateUserProfile(userId: string, input: ProfileUpdateInput): Promise<ProfileContact>
  findUserForPasswordAuthentication(email: string, password: string): Promise<PasswordAuthentication | undefined>
  hasUserByEmail(email: string): Promise<boolean>
  isLoginEmailTaken(email: string): Promise<boolean>
  getAccountPasswordHash(identity: AccountSessionIdentity): Promise<string | undefined>
  changeAccountCredentials(input: AccountCredentialChange): Promise<void>
  createEmailVerificationChallenge(input: CreateVerificationChallengeInput): Promise<VerificationChallengeCreation>
  invalidateVerificationChallenge(id: string): Promise<void>
  markVerificationChallengeDelivered(id: string): Promise<void>
  registerUserWithVerification(input: RegisterInput, verification: { codeHash: string; verifiedAt?: string }): Promise<RegisterResult>
  resetPasswordWithVerification(input: PasswordResetCompletion): Promise<void>
  startLoginAttempt(input: { email: string; ipAddress?: string; windowMs?: number; emailLimit?: number; ipLimit?: number }): Promise<LoginAttemptReservation>
  finishLoginAttempt(id: string, succeeded: boolean, failureReason?: string): Promise<void>
  getMfaCredential(userId: string): Promise<MfaCredential | undefined>
  createMfaChallenge(input: CreateMfaChallengeInput): Promise<MfaChallenge>
  findMfaChallengeByTokenHash(tokenHash: string): Promise<MfaChallenge | undefined>
  recordMfaChallengeFailure(id: string): Promise<void>
  completeMfaChallenge(id: string, credential: MfaCredential): Promise<void>
  invalidateMfaChallenge(id: string): Promise<void>
  revokeAllSessions(userId: string): Promise<void>
  createSession(user: SessionUser, ttlMs?: number, metadata?: SessionIssuanceMetadata): Promise<{ session: AuthSession; token: string }>
  findSessionByToken(token: string): Promise<AuthSession | undefined>
  revokeSession(sessionId: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  cleanupExpiredSessions(): Promise<number>
  listWorkspaces(userId: string): Promise<WorkspaceSummary[]>
  createWorkspace(userId: string, input: WorkspaceCreateInput): Promise<WorkspaceSummary>
  archiveWorkspace(userId: string, workspaceId: string): Promise<void>
  resetWorkspace(userId: string, workspaceId: string): Promise<void>
  selectWorkspace(sessionId: string, userId: string, workspaceId: string): Promise<SessionUser>
}

interface QueryableClient {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
  release(): void
}

interface Queryable {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
  connect?(): Promise<QueryableClient>
}

const TTL_MS = 1000 * 60 * 60 * 12
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()
const authError = (message: string, code: string, status: number) => Object.assign(new Error(message), { code, status })

function verificationRow(row: any): VerificationChallengeRecord {
  return {
    id: row.id,
    purpose: row.purpose,
    email: row.email,
    codeHash: row.code_hash,
    expiresAt: iso(row.expires_at),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    ...(row.consumed_at ? { consumedAt: iso(row.consumed_at) } : {}),
    ...(row.invalidated_at ? { invalidatedAt: iso(row.invalidated_at) } : {}),
    ...(row.request_ip ? { requestIp: String(row.request_ip) } : {}),
    ...(row.user_id ? { userId: String(row.user_id) } : {}),
    ...(row.delivered_at ? { deliveredAt: iso(row.delivered_at) } : {}),
    createdAt: iso(row.created_at),
  }
}

function mfaChallengeRow(row: any): MfaChallenge {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    userId: row.user_id,
    ...(row.login_attempt_id ? { loginAttemptId: String(row.login_attempt_id) } : {}),
    kind: row.kind,
    ...(row.encrypted_secret ? { encryptedSecret: row.encrypted_secret } : {}),
    expiresAt: iso(row.expires_at),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    ...(row.consumed_at ? { consumedAt: iso(row.consumed_at) } : {}),
    ...(row.invalidated_at ? { invalidatedAt: iso(row.invalidated_at) } : {}),
    ...(row.request_ip ? { requestIp: String(row.request_ip) } : {}),
    createdAt: iso(row.created_at),
  }
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly db: Queryable) {}

  private async transaction<T>(operation: (client: QueryableClient) => Promise<T>): Promise<T> {
    if (!this.db.connect) throw new Error('This operation requires a transactional database connection')
    const client = await this.db.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private async lockEmail(client: QueryableClient, purpose: string, email: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${purpose}:${email.trim().toLowerCase()}`])
  }

  async findUserByEmailPassword(email: string, password: string): Promise<SessionUser | undefined> {
    return (await this.findUserForPasswordAuthentication(email, password))?.user
  }

  async findUserById(userId: string): Promise<SessionUser | undefined> {
    const result = await this.db.query<any>(
      `SELECT u.id,u.user_no,u.display_name,u.email,u.phone,u.department_id,d.code AS department_code,
              (SELECT p.role FROM platform_operators p WHERE p.user_id=u.id AND p.is_active=true) AS platform_role,
              COALESCE((SELECT r.code FROM user_roles ur JOIN roles r ON r.id=ur.role_id
                        WHERE ur.user_id=u.id ORDER BY r.code LIMIT 1),'recruiter') AS role
         FROM users u LEFT JOIN departments d ON d.id=u.department_id
        WHERE u.id=$1::uuid AND u.is_active=true LIMIT 1`,
      [userId],
    )
    const row = result.rows[0]
    if (!row) return undefined
    return {
      id: row.id,
      ...(row.user_no ? { userNo: row.user_no } : {}),
      name: row.display_name,
      email: row.email,
      ...(row.phone ? { phone: row.phone } : {}),
      role: 'recruiter',
      departmentId: row.department_code ?? row.department_id ?? '',
      ...(row.platform_role ? { platformRole: row.platform_role } : {}),
    }
  }

  async updateUserProfile(userId: string, input: ProfileUpdateInput): Promise<ProfileContact> {
    const phoneProvided = Object.prototype.hasOwnProperty.call(input, 'phone')
    const result = await this.db.query<any>(
      `UPDATE users
          SET display_name=COALESCE($2,display_name),
              phone=CASE WHEN $3::boolean THEN NULLIF($4,'') ELSE phone END
        WHERE id=$1::uuid AND is_active=true
        RETURNING display_name,phone`,
      [userId, input.name ?? null, phoneProvided, input.phone ?? null],
    )
    const row = result.rows[0]
    if (!row) throw authError('账号不存在或已停用', 'PROFILE_NOT_FOUND', 404)
    return {
      name: row.display_name,
      ...(row.phone ? { phone: row.phone } : {}),
    }
  }

  async findUserForPasswordAuthentication(email: string, password: string): Promise<PasswordAuthentication | undefined> {
    const result = await this.db.query<any>(
      `SELECT u.id, u.user_no, u.display_name, u.email, u.phone, u.password_hash, u.department_id, d.code AS department_code,
              (SELECT p.role FROM platform_operators p WHERE p.user_id=u.id AND p.is_active=true) AS platform_role,
              EXISTS (SELECT 1 FROM user_mfa_credentials m WHERE m.user_id=u.id) AS mfa_enabled,
              COALESCE((SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id ORDER BY r.code LIMIT 1), 'recruiter') AS role
         FROM users u LEFT JOIN departments d ON d.id = u.department_id
        WHERE lower(u.email) = lower($1) AND u.is_active = true LIMIT 1`,
      [email.trim()],
    )
    const row = result.rows[0]
    if (!row?.password_hash || !(await verifyPassword(password, row.password_hash))) return undefined
    await this.db.query('UPDATE users SET last_login_at = now() WHERE id = $1::uuid', [row.id])
    return {
      user: {
        id: row.id,
        ...(row.user_no ? { userNo: row.user_no } : {}),
        name: row.display_name,
        email: row.email,
        ...(row.phone ? { phone: row.phone } : {}),
        role: 'recruiter',
        departmentId: row.department_code ?? row.department_id ?? '',
        ...(row.platform_role ? { platformRole: row.platform_role } : {}),
      },
      mfaEnabled: Boolean(row.mfa_enabled),
      passwordHash: row.password_hash,
    }
  }

  async hasUserByEmail(email: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM users WHERE lower(email)=lower($1) AND is_active=true) AS exists',
      [email.trim()],
    )
    return Boolean(result.rows[0]?.exists)
  }

  async isLoginEmailTaken(email: string): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM users WHERE lower(email)=lower($1)) AS exists', [email],
    )
    return Boolean(rows[0]?.exists)
  }

  async getAccountPasswordHash(identity: AccountSessionIdentity): Promise<string | undefined> {
    const { rows } = await this.db.query<{ password_hash: string | null }>(
      `SELECT u.password_hash FROM users u JOIN sessions s ON s.user_id=u.id
        WHERE u.id=$1 AND s.id=$2 AND lower(u.email)=$3 AND u.is_active
          AND s.revoked_at IS NULL AND s.expires_at>now()`,
      [identity.userId, identity.sessionId, identity.email],
    )
    return rows[0]?.password_hash ?? undefined
  }

  async changeAccountCredentials(input: AccountCredentialChange): Promise<void> {
    const newEmail = 'newEmail' in input ? input.newEmail : undefined
    const resetEmails = newEmail ? [input.email, newEmail].sort() : [input.email]
    try {
      const outcome = await this.transaction(async (client) => {
        await this.lockEmail(client, 'verification:email-change-user', input.userId)
        // Password reset takes this lock before touching the user row as well.
        for (const email of resetEmails) await this.lockEmail(client, 'verification:password_reset', email)
        const { rows } = await client.query(
          `SELECT u.id FROM users u JOIN sessions s ON s.user_id=u.id
            WHERE u.id=$1 AND s.id=$2 AND lower(u.email)=$3 AND u.password_hash=$4 AND u.is_active
              AND s.revoked_at IS NULL AND s.expires_at>now() FOR UPDATE OF u,s`,
          [input.userId, input.sessionId, input.email, input.expectedPasswordHash],
        )
        if (!rows.length) throw authError('登录状态已变化，请重新登录后再试', 'ACCOUNT_SESSION_CHANGED', 409)
        if ('newEmail' in input) {
          const result = await client.query<{ id: string; code_hash: string }>(
            `SELECT id,code_hash FROM email_verification_challenges
              WHERE purpose='email_change' AND user_id=$1 AND lower(email)=$2 AND delivered_at IS NOT NULL
                AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>clock_timestamp() AND attempts<max_attempts
              ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
            [input.userId, input.newEmail],
          )
          const challenge = result.rows[0]
          if (!challenge) return false
          if (!safeHashEqual(input.codeHash, challenge.code_hash)) {
            await client.query(
              `UPDATE email_verification_challenges SET attempts=attempts+1,
                 invalidated_at=CASE WHEN attempts+1>=max_attempts THEN now() ELSE invalidated_at END WHERE id=$1`,
              [challenge.id],
            )
            return false
          }
          const updated = await client.query(
            `UPDATE users SET email=$2,email_verified_at=now(),updated_at=now()
              WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM users WHERE lower(email)=$2) RETURNING id`,
            [input.userId, input.newEmail],
          )
          if (!updated.rows.length) throw authError('新邮箱已被其他账号使用', 'EMAIL_ALREADY_EXISTS', 409)
          await client.query('UPDATE email_verification_challenges SET consumed_at=now() WHERE id=$1', [challenge.id])
        } else {
          if (input.passwordCodeHash) {
            const result = await client.query<{ id: string; code_hash: string }>(
              `SELECT id,code_hash FROM email_verification_challenges
                WHERE purpose='password_reset' AND user_id IS NULL AND lower(email)=$1 AND delivered_at IS NOT NULL
                  AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>clock_timestamp() AND attempts<max_attempts
                ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [input.email],
            )
            const challenge = result.rows[0]
            if (!challenge) return false
            if (!safeHashEqual(input.passwordCodeHash, challenge.code_hash)) {
              await client.query(`UPDATE email_verification_challenges SET attempts=attempts+1,
                invalidated_at=CASE WHEN attempts+1>=max_attempts THEN now() ELSE invalidated_at END WHERE id=$1`, [challenge.id])
              return false
            }
            await client.query('UPDATE email_verification_challenges SET consumed_at=now() WHERE id=$1', [challenge.id])
          }
          await client.query('UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1', [input.userId, input.newPasswordHash])
        }
        await client.query(
          `UPDATE email_verification_challenges SET invalidated_at=now()
            WHERE consumed_at IS NULL AND invalidated_at IS NULL AND
              ((purpose='email_change' AND user_id=$1) OR (purpose='password_reset' AND lower(email)=ANY($2::text[])))`,
          [input.userId, resetEmails],
        )
        await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [input.userId])
        await client.query('UPDATE mfa_login_challenges SET invalidated_at=now() WHERE user_id=$1 AND invalidated_at IS NULL', [input.userId])
        return true
      })
      if (!outcome) throw authError('验证码无效或已过期，请重新获取', 'INVALID_VERIFICATION_CODE', 400)
    } catch (error) {
      if (newEmail && (error as { code?: string; constraint?: string }).code === '23505' && (error as { constraint?: string }).constraint === 'users_email_key') {
        throw authError('新邮箱已被其他账号使用', 'EMAIL_ALREADY_EXISTS', 409)
      }
      throw error
    }
  }

  async verifyAccountPasswordCode(input: AccountSessionIdentity & { expectedPasswordHash: string; codeHash: string }): Promise<void> {
    const valid = await this.transaction(async client => {
      await this.lockEmail(client, 'verification:password_reset', input.email)
      const identity = await client.query(`SELECT u.id FROM users u JOIN sessions s ON s.user_id=u.id
        WHERE u.id=$1 AND s.id=$2 AND lower(u.email)=$3 AND u.password_hash=$4 AND u.is_active
        AND s.revoked_at IS NULL AND s.expires_at>now() FOR UPDATE OF u,s`, [input.userId, input.sessionId, input.email, input.expectedPasswordHash])
      if (!identity.rows.length) throw authError('登录状态已变化，请重新登录', 'ACCOUNT_SESSION_CHANGED', 409)
      const { rows } = await client.query<{ id: string; code_hash: string }>(`SELECT id,code_hash FROM email_verification_challenges
        WHERE purpose='password_reset' AND user_id IS NULL AND lower(email)=$1 AND delivered_at IS NOT NULL
        AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>clock_timestamp() AND attempts<max_attempts
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [input.email])
      if (!rows[0]) return false
      if (safeHashEqual(input.codeHash, rows[0].code_hash)) return true
      await client.query(`UPDATE email_verification_challenges SET attempts=attempts+1,
        invalidated_at=CASE WHEN attempts+1>=max_attempts THEN now() ELSE invalidated_at END WHERE id=$1`, [rows[0].id])
      return false
    })
    if (!valid) throw authError('验证码无效或已过期，请重新获取', 'INVALID_VERIFICATION_CODE', 400)
  }

  async createEmailVerificationChallenge(input: CreateVerificationChallengeInput): Promise<VerificationChallengeCreation> {
    const email = input.email.trim().toLowerCase()
    return this.transaction(async (client) => {
      await this.lockEmail(client, `verification:${input.purpose}`, email)
      if (input.userId) await this.lockEmail(client, 'verification:email-change-user', input.userId)
      if (input.requestIp) await this.lockEmail(client, 'verification:ip', input.requestIp)
      const latest = await client.query<any>(
        `SELECT id, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (created_at + interval '60 seconds' - now()))))::integer AS retry_after
           FROM email_verification_challenges
          WHERE purpose=$1 AND (lower(email)=lower($2) OR user_id=$3::uuid)
            AND created_at > now()-interval '60 seconds'
          ORDER BY created_at DESC LIMIT 1`,
        [input.purpose, email, input.userId ?? null],
      )
      if (Number(latest.rows[0]?.retry_after ?? 0) > 0) {
        return { retryAfterSeconds: Number(latest.rows[0].retry_after) }
      }
      const emailCounts = await client.query<{ email_hourly: string; email_daily: string }>(
        `SELECT
           count(*) FILTER (WHERE created_at > now()-interval '1 hour') AS email_hourly,
           count(*) FILTER (WHERE created_at > now()-interval '24 hours') AS email_daily
         FROM email_verification_challenges
         WHERE purpose=$1 AND (lower(email)=lower($2) OR user_id=$3::uuid)
           AND created_at > now()-interval '24 hours'`,
        [input.purpose, email, input.userId ?? null],
      )
      const ipCounts = input.requestIp
        ? await client.query<{ ip_hourly: string }>(
          `SELECT count(*) AS ip_hourly
             FROM email_verification_challenges
            WHERE request_ip=$1::inet AND created_at > now()-interval '1 hour'`,
          [input.requestIp],
        )
        : undefined
      const usage = emailCounts.rows[0]
      if (Number(usage?.email_hourly ?? 0) >= 5 || Number(usage?.email_daily ?? 0) >= 15 || Number(ipCounts?.rows[0]?.ip_hourly ?? 0) >= 20) {
        return { retryAfterSeconds: Number(usage?.email_daily ?? 0) >= 15 ? 86_400 : 3_600 }
      }
      await client.query(
        `UPDATE email_verification_challenges SET invalidated_at=now()
          WHERE purpose=$1 AND consumed_at IS NULL AND invalidated_at IS NULL
            AND (($3::uuid IS NULL AND lower(email)=lower($2)) OR user_id=$3::uuid)`,
        [input.purpose, email, input.userId ?? null],
      )
      const inserted = await client.query<any>(
        `INSERT INTO email_verification_challenges
          (purpose,email,code_hash,expires_at,max_attempts,request_ip,user_id)
         VALUES ($1,$2,$3,now()+($4::bigint * interval '1 millisecond'),$5,$6::inet,$7::uuid)
         RETURNING *`,
        [input.purpose, email, input.codeHash, input.expiresInMs, input.maxAttempts, input.requestIp ?? null, input.userId ?? null],
      )
      return { challenge: verificationRow(inserted.rows[0]), retryAfterSeconds: 60 }
    })
  }

  async invalidateVerificationChallenge(id: string): Promise<void> {
    await this.db.query(
      `UPDATE email_verification_challenges SET invalidated_at=now()
        WHERE id=$1::uuid AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [id],
    )
  }

  async markVerificationChallengeDelivered(id: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE email_verification_challenges SET delivered_at=now()
        WHERE id=$1 AND invalidated_at IS NULL AND expires_at>now() RETURNING id`, [id],
    )
    if (!result.rows.length) throw new Error('Email change challenge is no longer active')
  }

  async registerUserWithVerification(input: RegisterInput, verification: { codeHash: string; verifiedAt?: string }): Promise<RegisterResult> {
    const data = normalizeRegistrationInput(input)
    const passwordHash = await hashPassword(data.password)
    try {
      const outcome = await this.transaction(async (client) => {
        await this.lockEmail(client, 'verification:registration', data.email)
        const challengeResult = await client.query<any>(
          `SELECT * FROM email_verification_challenges
            WHERE purpose='registration' AND lower(email)=lower($1) AND consumed_at IS NULL AND invalidated_at IS NULL
            ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [data.email],
        )
        const challenge = challengeResult.rows[0]
        if (!challenge || Date.parse(iso(challenge.expires_at)) <= Date.now() || !safeHashEqual(verification.codeHash, challenge.code_hash)) {
          if (challenge) {
            const invalidate = Number(challenge.attempts) + 1 >= Number(challenge.max_attempts) || Date.parse(iso(challenge.expires_at)) <= Date.now()
            await client.query(
              `UPDATE email_verification_challenges
                  SET attempts=attempts+1, invalidated_at=CASE WHEN $2 THEN now() ELSE invalidated_at END
                WHERE id=$1::uuid`,
              [challenge.id, invalidate],
            )
          }
          return { error: authError('验证码无效或已过期，请重新获取', 'INVALID_VERIFICATION_CODE', 400) } as const
        }
        await client.query('UPDATE email_verification_challenges SET consumed_at=now() WHERE id=$1::uuid', [challenge.id])
        const userResult = await client.query<any>(
          `INSERT INTO users (email,display_name,phone,password_hash,registration_source,is_active,email_verified_at)
           VALUES ($1,$2,$3,$4,'open_registration',true,COALESCE($5::timestamptz,now()))
           RETURNING id,email,display_name,user_no`,
          [data.email, data.name, data.phone, passwordHash, verification.verifiedAt ?? null],
        )
        const user = userResult.rows[0]
        const workspaceResult = await client.query<any>(
          `INSERT INTO organizations (name,kind,created_by,service_status)
           VALUES ($1,'production',$2::uuid,'trial')
           RETURNING id,name,kind,status,created_at,service_status,trial_ends_at`,
          [data.companyName, user.id],
        )
        const workspace = workspaceResult.rows[0]
        if (process.env.TENANT_SCHEMA_ROUTING === 'on') {
          const schemaName = await client.query<{ schema_name: string }>(
            'SELECT public.initialize_organization_schema($1::uuid) AS schema_name', [workspace.id],
          )
          if (schemaName.rows[0]?.schema_name !== organizationSchemaName(workspace.id)) {
            throw new Error('ORGANIZATION_SCHEMA_INITIALIZATION_FAILED')
          }
          await client.query('SELECT set_config($1,$2,true)', ['search_path', `${schemaName.rows[0].schema_name},public`])
        }
        await client.query(
          `INSERT INTO organization_members (organization_id,user_id,role,business_role)
           VALUES ($1::uuid,$2::uuid,'owner','recruiter')`,
          [workspace.id, user.id],
        )
        await client.query(
          `INSERT INTO user_roles (user_id,role_id) SELECT $1::uuid,id FROM roles WHERE code='recruiter' ON CONFLICT DO NOTHING`,
          [user.id],
        )
        await client.query(
          `INSERT INTO audit_logs (organization_id,actor_user_id,action,resource_type,resource_id,metadata)
           VALUES ($1::uuid,$2::uuid,'workspace.member.owner_created','organization_member',$2::uuid,$3::jsonb)`,
          [workspace.id, user.id, JSON.stringify({ source: 'open_registration', emailVerified: true })],
        )
        await client.query(
          `INSERT INTO platform_audit_logs (actor_user_id,organization_id,action,metadata)
           VALUES ($1::uuid,$2::uuid,'platform.user.registered',$3::jsonb)`,
          [user.id, workspace.id, JSON.stringify({ source: 'open_registration', emailVerified: true })],
        )
        await client.query(
          `INSERT INTO registration_attempts (email,ip_address,succeeded) VALUES ($1,$2::inet,true)`,
          [data.email, input.ipAddress ?? null],
        )
        const sessionUser: SessionUser = {
          id: user.id,
          ...(user.user_no ? { userNo: user.user_no } : {}),
          name: user.display_name,
          email: user.email,
          role: 'recruiter',
          departmentId: '',
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceKind: workspace.kind,
        }
        return {
          result: {
            user: sessionUser,
            workspace: {
              id: workspace.id,
              name: workspace.name,
              kind: workspace.kind,
              status: workspace.status,
              role: 'owner',
              createdAt: iso(workspace.created_at),
              serviceStatus: workspace.service_status,
              trialEndsAt: workspace.trial_ends_at ? iso(workspace.trial_ends_at) : null,
              serviceAvailable: true,
            },
          } satisfies RegisterResult,
        } as const
      })
      if ('error' in outcome) throw outcome.error
      return outcome.result
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw authError('该邮箱已注册，请直接登录', 'EMAIL_ALREADY_EXISTS', 409)
      }
      throw error
    }
  }

  async resetPasswordWithVerification(input: PasswordResetCompletion): Promise<void> {
    const email = input.email.trim().toLowerCase()
    const outcome = await this.transaction(async (client) => {
      await this.lockEmail(client, 'verification:password_reset', email)
      const challengeResult = await client.query<any>(
        `SELECT * FROM email_verification_challenges
          WHERE purpose='password_reset' AND lower(email)=lower($1) AND consumed_at IS NULL AND invalidated_at IS NULL
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [email],
      )
      const challenge = challengeResult.rows[0]
      if (!challenge || Date.parse(iso(challenge.expires_at)) <= Date.now() || !safeHashEqual(input.codeHash, challenge.code_hash)) {
        if (challenge) {
          const invalidate = Number(challenge.attempts) + 1 >= Number(challenge.max_attempts) || Date.parse(iso(challenge.expires_at)) <= Date.now()
          await client.query(
            `UPDATE email_verification_challenges
                SET attempts=attempts+1, invalidated_at=CASE WHEN $2 THEN now() ELSE invalidated_at END
              WHERE id=$1::uuid`,
            [challenge.id, invalidate],
          )
        }
        return false
      }
      await client.query('UPDATE email_verification_challenges SET consumed_at=now() WHERE id=$1::uuid', [challenge.id])
      const updated = await client.query<{ id: string }>(
        `UPDATE users SET password_hash=$2,updated_at=now()
          WHERE lower(email)=lower($1) AND is_active=true RETURNING id`,
        [email, input.passwordHash],
      )
      const userId = updated.rows[0]?.id
      if (!userId) return false
      await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1::uuid AND revoked_at IS NULL', [userId])
      await client.query('DELETE FROM mfa_login_challenges WHERE user_id=$1::uuid AND consumed_at IS NULL', [userId])
      await client.query('DELETE FROM user_mfa_credentials WHERE user_id=$1::uuid', [userId])
      return true
    })
    if (!outcome) throw authError('验证码无效或已过期，请重新获取', 'INVALID_VERIFICATION_CODE', 400)
  }

  async startLoginAttempt(input: { email: string; ipAddress?: string; windowMs?: number; emailLimit?: number; ipLimit?: number }): Promise<LoginAttemptReservation> {
    const email = input.email.trim().toLowerCase()
    const windowMs = input.windowMs ?? 15 * 60_000
    const emailLimit = input.emailLimit ?? 5
    const ipLimit = input.ipLimit ?? 30
    return this.transaction(async (client) => {
      await this.lockEmail(client, 'login:email', email)
      if (input.ipAddress) await this.lockEmail(client, 'login:ip', input.ipAddress)
      const counts = await client.query<{ email_count: string; ip_count: string }>(
        `SELECT
           count(*) FILTER (WHERE lower(email)=lower($1)) AS email_count,
           count(*) FILTER (WHERE $2::inet IS NOT NULL AND ip_address=$2::inet) AS ip_count
         FROM login_attempts
         WHERE succeeded=false AND attempted_at > now()-($3::bigint * interval '1 millisecond')`,
        [email, input.ipAddress ?? null, windowMs],
      )
      const usage = counts.rows[0]
      if (Number(usage?.email_count ?? 0) >= emailLimit || Number(usage?.ip_count ?? 0) >= ipLimit) {
        return { id: '', allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) }
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO login_attempts (email,ip_address,succeeded,failure_reason)
         VALUES ($1,$2::inet,false,'pending') RETURNING id::text AS id`,
        [email, input.ipAddress ?? null],
      )
      return { id: inserted.rows[0]!.id, allowed: true, retryAfterSeconds: 0 }
    })
  }

  async finishLoginAttempt(id: string, succeeded: boolean, failureReason?: string): Promise<void> {
    if (!id) return
    if (succeeded) {
      await this.db.query(
        `WITH completed AS (
           UPDATE login_attempts
              SET succeeded=true,failure_reason=NULL
            WHERE id=$1::bigint
            RETURNING lower(email) AS email
         )
         UPDATE login_attempts
            SET succeeded=true,failure_reason='cleared_by_successful_login'
          WHERE succeeded=false
            AND lower(email)=(SELECT email FROM completed)
            AND attempted_at > now()-interval '15 minutes'`,
        [id],
      )
      return
    }
    await this.db.query(
      `UPDATE login_attempts
          SET succeeded=false,failure_reason=$2,attempted_at=now()
        WHERE id=$1::bigint`,
      [id, failureReason ?? null],
    )
  }

  async getMfaCredential(userId: string): Promise<MfaCredential | undefined> {
    const result = await this.db.query<any>(
      `SELECT user_id,secret_encrypted,recovery_code_hashes,last_used_step,enabled_at
         FROM user_mfa_credentials WHERE user_id=$1::uuid LIMIT 1`,
      [userId],
    )
    const row = result.rows[0]
    if (!row) return undefined
    const recoveryCodeHashes = Array.isArray(row.recovery_code_hashes) ? row.recovery_code_hashes.map(String) : []
    return {
      userId: row.user_id,
      secretEncrypted: row.secret_encrypted,
      recoveryCodeHashes,
      ...(row.last_used_step === null || row.last_used_step === undefined ? {} : { lastUsedStep: Number(row.last_used_step) }),
      enabledAt: iso(row.enabled_at),
    }
  }

  async createMfaChallenge(input: CreateMfaChallengeInput): Promise<MfaChallenge> {
    const insert = async (client: Queryable) => {
      if (input.expectedPasswordHash) {
        const current = await client.query('SELECT id FROM users WHERE id=$1 AND password_hash=$2 AND is_active FOR UPDATE', [input.userId, input.expectedPasswordHash])
        if (!current.rows.length) throw authError('账号凭据已更改，请重新登录', 'ACCOUNT_SESSION_CHANGED', 409)
      }
      const result = await client.query<any>(
        `INSERT INTO mfa_login_challenges
          (token_hash,user_id,login_attempt_id,kind,encrypted_secret,expires_at,max_attempts,request_ip)
         VALUES ($1,$2::uuid,$3::bigint,$4,$5,now()+($6::bigint * interval '1 millisecond'),$7,$8::inet)
         RETURNING *`,
        [input.tokenHash, input.userId, input.loginAttemptId ?? null, input.kind, input.encryptedSecret ?? null, input.expiresInMs, input.maxAttempts, input.requestIp ?? null],
      )
      return mfaChallengeRow(result.rows[0])
    }
    return input.expectedPasswordHash ? this.transaction(insert) : insert(this.db)
  }

  async findMfaChallengeByTokenHash(tokenHash: string): Promise<MfaChallenge | undefined> {
    const result = await this.db.query<any>(
      `SELECT * FROM mfa_login_challenges
        WHERE token_hash=$1 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>now() LIMIT 1`,
      [tokenHash],
    )
    return result.rows[0] ? mfaChallengeRow(result.rows[0]) : undefined
  }

  async recordMfaChallengeFailure(id: string): Promise<void> {
    await this.db.query(
      `UPDATE mfa_login_challenges
          SET attempts=attempts+1,
              invalidated_at=CASE WHEN attempts+1>=max_attempts THEN now() ELSE invalidated_at END
        WHERE id=$1::uuid AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [id],
    )
  }

  async completeMfaChallenge(id: string, credential: MfaCredential): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('SELECT u.id FROM users u JOIN mfa_login_challenges c ON c.user_id=u.id WHERE c.id=$1 FOR UPDATE OF u', [id])
      const challengeResult = await client.query<any>(
        `SELECT * FROM mfa_login_challenges
          WHERE id=$1::uuid AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>now()
          FOR UPDATE`,
        [id],
      )
      const challenge = challengeResult.rows[0]
      if (!challenge) throw authError('MFA 验证已失效，请重新登录', 'MFA_CHALLENGE_EXPIRED', 401)
      const currentResult = await client.query<any>(
        'SELECT * FROM user_mfa_credentials WHERE user_id=$1::uuid FOR UPDATE',
        [challenge.user_id],
      )
      const existing = currentResult.rows[0]
      if (challenge.kind === 'setup') {
        if (existing) throw authError('该账号已启用 MFA', 'MFA_ALREADY_ENABLED', 409)
        await client.query(
          `INSERT INTO user_mfa_credentials (user_id,secret_encrypted,recovery_code_hashes,last_used_step)
           VALUES ($1::uuid,$2,$3::jsonb,$4)`,
          [challenge.user_id, credential.secretEncrypted, JSON.stringify(credential.recoveryCodeHashes), credential.lastUsedStep ?? null],
        )
      } else {
        if (!existing) throw authError('MFA 凭据不存在', 'INVALID_MFA_CODE', 401)
        const existingRecovery = Array.isArray(existing.recovery_code_hashes) ? existing.recovery_code_hashes.map(String) : []
        if (credential.lastUsedStep !== undefined) {
          const storedStep = existing.last_used_step === null || existing.last_used_step === undefined ? -1 : Number(existing.last_used_step)
          if (credential.lastUsedStep <= storedStep) throw authError('动态验证码已使用，请等待下一个验证码', 'MFA_CODE_REPLAYED', 401)
          await client.query(
            `UPDATE user_mfa_credentials SET secret_encrypted=$2,recovery_code_hashes=$3::jsonb,last_used_step=$4,updated_at=now()
              WHERE user_id=$1::uuid`,
            [challenge.user_id, credential.secretEncrypted, JSON.stringify(existingRecovery), credential.lastUsedStep],
          )
        } else {
          if (credential.recoveryCodeHashes.length >= existingRecovery.length) {
            throw authError('恢复码已使用或无效', 'MFA_CODE_REPLAYED', 401)
          }
          await client.query(
            `UPDATE user_mfa_credentials SET recovery_code_hashes=$2::jsonb,updated_at=now() WHERE user_id=$1::uuid`,
            [challenge.user_id, JSON.stringify(credential.recoveryCodeHashes)],
          )
        }
      }
      await client.query('UPDATE mfa_login_challenges SET consumed_at=now() WHERE id=$1::uuid', [id])
    })
  }

  async invalidateMfaChallenge(id: string): Promise<void> {
    await this.db.query(
      `UPDATE mfa_login_challenges SET invalidated_at=now()
        WHERE id=$1::uuid AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [id],
    )
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.db.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1::uuid AND revoked_at IS NULL', [userId])
  }

  async listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
    const result = await this.db.query<any>(
      `SELECT o.id,o.name,o.kind,o.status,o.created_at,o.archived_at,o.service_status,o.trial_ends_at,
              organization_service_available(o.id) AS service_available,om.role
         FROM organizations o JOIN organization_members om ON om.organization_id=o.id
        WHERE om.user_id=$1::uuid ORDER BY o.status='active' DESC,o.created_at DESC`,
      [userId],
    )
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      role: row.role,
      createdAt: iso(row.created_at),
      serviceStatus: row.service_status,
      trialEndsAt: row.trial_ends_at ? iso(row.trial_ends_at) : null,
      serviceAvailable: row.service_available,
      ...(row.archived_at ? { archivedAt: iso(row.archived_at) } : {}),
    }))
  }

  async createWorkspace(userId: string, input: WorkspaceCreateInput): Promise<WorkspaceSummary> {
    const name = input.name.trim()
    if (!['test', 'production'].includes(input.kind)) throw authError('企业类型只能是测试企业或正式企业', 'VALIDATION_ERROR', 400)
    if (name.length < 2 || name.length > 120) throw authError('企业名称长度需为 2 到 120 个字符', 'VALIDATION_ERROR', 400)
    if (!this.db.connect) throw new Error('企业初始化需要事务连接')
    const client = await this.db.connect()
    let row: any
    try {
      await client.query('BEGIN')
      const result = await client.query<any>(
        `WITH created AS (
           INSERT INTO organizations (name,kind,created_by,service_status)
           VALUES ($1,$2,$3::uuid,'trial')
           RETURNING id,name,kind,status,created_at,service_status,trial_ends_at
         ), membership AS (
           INSERT INTO organization_members (organization_id,user_id,role,business_role)
           SELECT id,$3::uuid,'owner','recruiter' FROM created RETURNING organization_id
         ) SELECT created.* FROM created JOIN membership ON membership.organization_id=created.id`,
        [name, input.kind, userId],
      )
      row = result.rows[0]
      if (!row) throw new Error('创建企业失败')
      if (process.env.TENANT_SCHEMA_ROUTING === 'on') {
        const schema = await client.query<{ schema_name: string }>(
          'SELECT public.initialize_organization_schema($1::uuid) AS schema_name', [row.id],
        )
        if (schema.rows[0]?.schema_name !== organizationSchemaName(row.id)) throw new Error('ORGANIZATION_SCHEMA_INITIALIZATION_FAILED')
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    if (!row) throw new Error('创建企业失败')
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      role: 'owner',
      createdAt: iso(row.created_at),
      serviceStatus: row.service_status,
      trialEndsAt: row.trial_ends_at ? iso(row.trial_ends_at) : null,
      serviceAvailable: true,
    }
  }

  private async assertOwner(userId: string, workspaceId: string): Promise<any> {
    const result = await this.db.query<any>(
      `SELECT o.id,o.kind,o.status FROM organizations o
         JOIN organization_members om ON om.organization_id=o.id
        WHERE o.id=$1::uuid AND om.user_id=$2::uuid AND om.role='owner' LIMIT 1`,
      [workspaceId, userId],
    )
    const row = result.rows[0]
    if (!row) throw authError('无权操作该企业', 'FORBIDDEN', 403)
    return row
  }

  async archiveWorkspace(userId: string, workspaceId: string): Promise<void> {
    await this.assertOwner(userId, workspaceId)
    await this.db.query(`UPDATE organizations SET status='archived',archived_at=now() WHERE id=$1::uuid`, [workspaceId])
    await this.db.query('UPDATE sessions SET active_organization_id=NULL WHERE active_organization_id=$1::uuid', [workspaceId])
  }

  async resetWorkspace(userId: string, workspaceId: string): Promise<void> {
    const workspace = await this.assertOwner(userId, workspaceId)
    if (workspace.status !== 'active') throw authError('已归档的企业不能重置', 'WORKSPACE_ARCHIVED', 400)
    if (workspace.kind !== 'test') throw authError('只有测试企业可以重新开始', 'TEST_WORKSPACE_REQUIRED', 400)
    await this.db.query(`UPDATE organizations SET updated_at=now(),status='active',archived_at=NULL WHERE id=$1::uuid`, [workspaceId])
  }

  async selectWorkspace(sessionId: string, userId: string, workspaceId: string): Promise<SessionUser> {
    const result = await this.db.query<any>(
      `SELECT o.id AS workspace_id,o.name AS workspace_name,o.kind,u.user_no AS user_no,u.display_name AS name,u.email,u.phone,
              (SELECT p.role FROM platform_operators p WHERE p.user_id=u.id AND p.is_active=true) AS platform_role,
              COALESCE(d.code,om.department_id::text) AS department_id,om.business_role AS role
         FROM organizations o JOIN organization_members om ON om.organization_id=o.id
         JOIN users u ON u.id=om.user_id LEFT JOIN departments d ON d.id=om.department_id
        WHERE o.id=$1::uuid AND om.user_id=$2::uuid AND u.is_active=true AND organization_service_available(o.id) LIMIT 1`,
      [workspaceId, userId],
    )
    const row = result.rows[0]
    if (!row) throw authError('无权访问该企业', 'FORBIDDEN', 403)
    const updated = await this.db.query<{ id: string }>(
      'UPDATE sessions SET active_organization_id=$1::uuid WHERE id=$2::uuid AND user_id=$3::uuid AND revoked_at IS NULL RETURNING id',
      [workspaceId, sessionId, userId],
    )
    if (!updated.rows[0]) throw authError('登录状态已失效', 'AUTHENTICATION_REQUIRED', 401)
    return {
      id: userId,
      ...(row.user_no ? { userNo: row.user_no } : {}),
      name: row.name,
      email: row.email,
      ...(row.phone ? { phone: row.phone } : {}),
      role: 'recruiter',
      departmentId: row.department_id ?? '',
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      workspaceKind: row.kind,
      ...(row.platform_role ? { platformRole: row.platform_role } : {}),
    }
  }

  async createSession(user: SessionUser, ttlMs = TTL_MS, metadata: SessionIssuanceMetadata = {}) {
    const token = randomBytes(32).toString('base64url')
    const now = new Date()
    const expires = new Date(now.getTime() + ttlMs)
    const id = randomUUID()
    const csrfHash = hash(randomBytes(32).toString('base64url'))
    const insert = async (client: Queryable) => {
      if (metadata.expectedPasswordHash || metadata.mfaChallengeId) {
        const current = await client.query(
          `SELECT id FROM users WHERE id=$1 AND email=$2 AND is_active
            AND ($3::text IS NULL OR password_hash=$3) FOR UPDATE`, [user.id, user.email, metadata.expectedPasswordHash ?? null],
        )
        if (!current.rows.length) throw authError('账号凭据已更改，请重新登录', 'ACCOUNT_SESSION_CHANGED', 409)
        if (metadata.mfaChallengeId) {
          const challenge = await client.query(
            'SELECT id FROM mfa_login_challenges WHERE id=$1 AND user_id=$2 AND consumed_at IS NOT NULL AND invalidated_at IS NULL',
            [metadata.mfaChallengeId, user.id],
          )
          if (!challenge.rows.length) throw authError('账号凭据已更改，请重新登录', 'ACCOUNT_SESSION_CHANGED', 409)
        }
      }
      const result = user.workspaceId
        ? await client.query<any>(
          `INSERT INTO sessions (id,user_id,token_hash,csrf_token_hash,expires_at,created_at,last_seen_at,user_agent,ip_address,active_organization_id)
           VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$6,$7,$8::inet,$9::uuid)
           RETURNING id,user_id,token_hash,created_at,expires_at,last_seen_at`,
          [id, user.id, hash(token), csrfHash, expires, now, metadata.userAgent ?? null, metadata.ipAddress ?? null, user.workspaceId],
        )
        : await client.query<any>(
          `INSERT INTO sessions (id,user_id,token_hash,csrf_token_hash,expires_at,created_at,last_seen_at,user_agent,ip_address)
           VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$6,$7,$8::inet)
           RETURNING id,user_id,token_hash,created_at,expires_at,last_seen_at`,
          [id, user.id, hash(token), csrfHash, expires, now, metadata.userAgent ?? null, metadata.ipAddress ?? null],
        )
      const row = result.rows[0]
      if (!row) throw new Error('Failed to create session')
      return {
        token,
        session: {
          sessionId: row.id,
          userId: row.user_id,
          tokenHash: row.token_hash,
          createdAt: iso(row.created_at),
          expiresAt: iso(row.expires_at),
          lastSeenAt: iso(row.last_seen_at),
          user,
        } satisfies AuthSession,
      }
    }
    return metadata.expectedPasswordHash || metadata.mfaChallengeId ? this.transaction(insert) : insert(this.db)
  }

  async findSessionByToken(token: string): Promise<AuthSession | undefined> {
    if (!token) return undefined
    const result = await this.db.query<any>(
      `SELECT s.id,s.user_id,s.token_hash,s.created_at,s.expires_at,s.last_seen_at,s.active_organization_id,
              active_o.name AS active_o_name,active_o.kind AS active_o_kind,
              (SELECT p.role FROM platform_operators p WHERE p.user_id=u.id AND p.is_active=true) AS platform_role,
              u.user_no AS user_no,u.display_name AS name,u.email,u.phone,
              CASE WHEN s.active_organization_id IS NOT NULL THEN COALESCE(active_m.business_role,'recruiter') ELSE COALESCE(ur.role,'recruiter') END AS role,
              CASE WHEN s.active_organization_id IS NOT NULL THEN active_m.department_id ELSE u.department_id END AS department_id,
              CASE WHEN s.active_organization_id IS NOT NULL THEN active_d.code ELSE d.code END AS department_code
         FROM sessions s JOIN users u ON u.id=s.user_id
         LEFT JOIN departments d ON d.id=u.department_id
         LEFT JOIN LATERAL (
           SELECT r.code AS role FROM user_roles x JOIN roles r ON r.id=x.role_id
           WHERE x.user_id=u.id ORDER BY r.code LIMIT 1
         ) ur ON true
         LEFT JOIN organization_members active_m ON active_m.organization_id=s.active_organization_id
           AND active_m.user_id=u.id AND EXISTS (
             SELECT 1 FROM organizations ao WHERE ao.id=active_m.organization_id AND organization_service_available(ao.id)
           )
         LEFT JOIN departments active_d ON active_d.id=active_m.department_id
         LEFT JOIN organizations active_o ON active_o.id=s.active_organization_id
           AND organization_service_available(active_o.id) AND active_m.user_id IS NOT NULL
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.is_active=true LIMIT 1`,
      [hash(token)],
    )
    const row = result.rows[0]
    if (!row) return undefined
    await this.db.query('UPDATE sessions SET last_seen_at=now() WHERE id=$1::uuid', [row.id])
    const user: SessionUser = {
      id: row.user_id,
      ...(row.user_no ? { userNo: row.user_no } : {}),
      name: row.name,
      email: row.email,
      ...(row.phone ? { phone: row.phone } : {}),
      role: 'recruiter',
      departmentId: row.department_code ?? row.department_id ?? '',
      ...(row.platform_role ? { platformRole: row.platform_role } : {}),
      ...(row.active_organization_id && !row.active_o_name ? { workspaceAccessIssue: 'unavailable' as const } : {}),
      ...(row.active_organization_id && row.active_o_name ? {
        workspaceId: row.active_organization_id,
        workspaceName: row.active_o_name,
        workspaceKind: row.active_o_kind,
      } : {}),
    }
    return {
      sessionId: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      lastSeenAt: new Date().toISOString(),
      user,
    }
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1::uuid AND revoked_at IS NULL', [sessionId])
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.revokeSession(sessionId)
  }

  async cleanupExpiredSessions(): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM sessions WHERE expires_at<=now() OR revoked_at<=now()-interval '30 days' RETURNING 1
       ) SELECT count(*)::text AS count FROM deleted`,
    )
    return Number(result.rows[0]?.count ?? 0)
  }
}
