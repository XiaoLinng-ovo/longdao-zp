import { EnterpriseAiStore } from '@smartrecruit-pro/enterprise-ai';
import { randomInt, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hashPassword } from '../auth/password.js';
import { readDingTalkEnvSettings, readResumeVirusScanSetting, updateDingTalkEnvSettings, updateResumeVirusScanSetting, type DingTalkEnvPatch } from './dingtalk-env-settings.js';
import { readAiEnvSettings, readAiSettings, testAiConnection, updateAiEnvSettings, type AiConnectionTestInput, type AiConnectionTestResult, type AiEnvPatch, type AiSettingsResponse } from './ai-settings.js';
import { resolveEnvFilePath } from './env-file.js';
import { readChannelConnectionInput, readChannelSettings, updateChannelSettings, type ChannelSettings } from '../integrations/channels/settings.js';
import { createChannelConnector } from '../integrations/channels/registry.js';
import type { ChannelProvider } from '../integrations/channels/types.js';
import { testDingTalkConnection, type DingTalkConnectionTestResult } from '../integrations/dingtalk/approval-client.js';

export interface AdminUserRecord {
  id: string;
  email: string;
  displayName: string;
  role: string;
  departmentCode: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminRoleRecord {
  id: string;
  code: string;
  name: string;
}

export interface InterviewerOptionRecord {
  id: string;
  displayName: string;
  email: string;
  departmentCode: string | null;
}

export interface AdminDepartmentRecord {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDepartmentCreate { name?: string }
export interface AdminDepartmentUpdate { name?: string; isActive?: boolean }

export interface DingTalkApprovalDepartmentConfig {
  id: string
  code: string
  name: string
  isActive: boolean
  dingTalkDepartmentId: number | null
  processCode: string | null
  configured: boolean
}

export interface DingTalkApprovalUserMapping {
  id: string
  displayName: string
  email: string
  departmentName: string | null
  dingTalkUserId: string | null
  configured: boolean
}

export interface DingTalkApprovalConfig {
  subjectType: 'recruitment_request'
  callbackUrl: string | null
  callbackUrlConfigured: boolean
  departments: DingTalkApprovalDepartmentConfig[]
  users: DingTalkApprovalUserMapping[]
}

export interface DingTalkApprovalConfigPatch {
  departmentId?: string
  dingTalkDepartmentId?: string | number | null
  processCode?: string | null
  userId?: string
  dingTalkUserId?: string | null
}

export interface AdminDepartmentDeleteResult {
  id: string;
  code: string;
  name: string;
  /** 随部门级联删除的审批策略行数（department_approval_policies.department_id → ON DELETE CASCADE）。 */
  removedApprovalPolicies: number;
}

export interface AdminAuditRecord {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AdminUserUpdate {
  displayName?: string;
  isActive?: boolean;
  departmentCode?: string | null;
  role?: string;
  password?: string;
}

export interface AdminUserCreate {
  email?: string;
  displayName?: string;
  organizationId?: string;
  departmentCode?: string;
  role?: string;
  password?: string;
}

export interface AdminUserCreateResult {
  user: AdminUserRecord;
  initialPassword: string;
  generatedPassword: boolean;
}

const ACCOUNT_ROLES = new Set(['recruiter', 'hiring_manager', 'approver', 'interviewer', 'hr_admin', 'admin']);

function generateAccountPassword(): string {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*-_'];
  const pick = (characters: string) => characters[randomInt(characters.length)]!;
  const characters = groups.join('');
  const password = groups.map(pick);
  while (password.length < 16) password.push(pick(characters));
  for (let i = password.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [password[i], password[j]] = [password[j]!, password[i]!];
  }
  return password.join('');
}

export interface AdminRoleUpdate {
  name?: string;
}


export type AiPromptSkillTarget = 'job_spec' | 'jd' | 'both' | 'resume_score'

export interface AiPromptSkillRecord {
  id: string
  name: string
  targetType: AiPromptSkillTarget
  jobIds: string[]
  content: string
  isActive: boolean
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface AiPromptSkillCreate {
  name?: string
  targetType?: AiPromptSkillTarget
  jobIds?: string[]
  content?: string
}

export interface AiPromptSkillUpdate {
  name?: string
  targetType?: AiPromptSkillTarget
  jobIds?: string[]
  content?: string
  isActive?: boolean
}

const USER_SELECT = `
  SELECT u.id, u.email, u.display_name, u.is_active, u.last_login_at, u.created_at,
         d.code AS department_code,
         COALESCE((SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                    WHERE ur.user_id = u.id ORDER BY r.code LIMIT 1), 'recruiter') AS role
    FROM users u
    LEFT JOIN departments d ON d.id = u.department_id`;

const AUDIT_SELECT = `
  SELECT a.id, a.actor_user_id, actor.email AS actor_email, a.action, a.resource_type,
         a.resource_id, a.request_id, a.metadata, a.created_at
    FROM audit_logs a
    LEFT JOIN users actor ON actor.id = a.actor_user_id`;

function toUser(row: Record<string, unknown>): AdminUserRecord {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: String(row.role),
    departmentCode: row.department_code === null || row.department_code === undefined ? null : String(row.department_code),
    isActive: Boolean(row.is_active),
    lastLoginAt: row.last_login_at instanceof Date ? row.last_login_at.toISOString() : (row.last_login_at as string | null) ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function toAudit(row: Record<string, unknown>): AdminAuditRecord {
  return {
    id: String(row.id),
    actorId: (row.actor_user_id as string | null) ?? null,
    actorEmail: (row.actor_email as string | null) ?? null,
    action: String(row.action),
    resourceType: String(row.resource_type),
    resourceId: (row.resource_id as string | null) ?? null,
    requestId: (row.request_id as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function toDepartment(row: Record<string, unknown>): AdminDepartmentRecord {
  const date = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value)
  return { id: String(row.id), code: String(row.code), name: String(row.name), isActive: Boolean(row.is_active), createdAt: date(row.created_at), updatedAt: date(row.updated_at) }
}

function toAiPromptSkill(row: Record<string, unknown>): AiPromptSkillRecord {
  const date = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value)
  return {
    id: String(row.id),
    name: String(row.name),
    targetType: String(row.target_type) as AiPromptSkillTarget,
    content: String(row.content),
    jobIds: Array.isArray(row.job_ids) ? row.job_ids.map(String) : [],
    isActive: Boolean(row.is_active),
    createdBy: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  }
}

const AI_SKILL_SELECT = `SELECT s.id, s.name, s.target_type, s.content, s.is_active, s.created_by, s.created_at, s.updated_at,
  ARRAY(SELECT b.job_id FROM ai_resume_scoring_skill_jobs b JOIN jobs j ON j.id = b.job_id WHERE b.skill_id = s.id AND (s.organization_id IS NULL OR j.organization_id = s.organization_id) ORDER BY b.job_id) AS job_ids
  FROM ai_prompt_skills s`
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * 管理后台服务：用户/角色/系统设置/审计日志的查询与维护。
 * 只做管理域操作，不触碰招聘领域状态机；写操作都会写 audit_logs（系统审计），
 * 与业务链路的 workflow_events（领域事件）区分开。
 */
export class AdminService {
  constructor(private readonly pool: Pool, private readonly envFilePath?: string, private readonly organizationId?: string) {}

  forOrganization(organizationId: string | undefined): AdminService {
    if (!organizationId) throw new AdminValidationError("请先选择企业工作空间");
    return new AdminService(this.pool, this.envFilePath, organizationId);
  }

  async listUsers(): Promise<AdminUserRecord[]> {
    const result = await this.pool.query(`${USER_SELECT} ORDER BY u.created_at DESC, u.email`);
    return result.rows.map(toUser);
  }

  async listAccountOrganizations(): Promise<Array<{ id: string; name: string }>> {
    const result = await this.pool.query('SELECT id, name FROM organizations WHERE organization_service_available(id) ORDER BY name, id');
    return result.rows.map(row => ({ id: String(row.id), name: String(row.name) }));
  }

  async createUser(input: AdminUserCreate, actorId: string, requestId?: string): Promise<AdminUserCreateResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AdminValidationError('账号信息格式无效');
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    const organizationId = typeof input.organizationId === 'string' ? input.organizationId.trim() : '';
    const departmentCode = typeof input.departmentCode === 'string' ? input.departmentCode.trim() : '';
    const role = input.role ?? 'recruiter';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new AdminValidationError('请输入有效的登录邮箱');
    if (!displayName || displayName.length > 80) throw new AdminValidationError('姓名不能为空且不能超过 80 个字符');
    if (!UUID_PATTERN.test(organizationId)) throw new AdminValidationError('请选择有效企业');
    if (!departmentCode || departmentCode.length > 100) throw new AdminValidationError('请选择有效部门');
    if (!ACCOUNT_ROLES.has(role)) throw new AdminValidationError('请选择有效的业务角色，不能创建平台管理员');
    if (input.password !== undefined && typeof input.password !== 'string') throw new AdminValidationError('密码格式无效');
    const generatedPassword = input.password === undefined || input.password === '';
    const initialPassword = generatedPassword ? generateAccountPassword() : input.password!;
    if (initialPassword.length < 8 || initialPassword.length > 128 || !initialPassword.trim()) throw new AdminValidationError('密码须为 8 至 128 个字符，不能全部为空格');
    const passwordHash = await hashPassword(initialPassword);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the organization before membership insertion to serialize seat allocation.
      const organization = await client.query('SELECT id FROM organizations WHERE id = $1 AND organization_service_available(id) FOR NO KEY UPDATE', [organizationId]);
      if (!organization.rows[0]) throw new AdminValidationError('企业不存在或服务不可用');
      const department = await client.query('SELECT id FROM departments WHERE code = $1 AND is_active = true FOR SHARE', [departmentCode]);
      if (!department.rows[0]) throw new AdminValidationError('部门不存在或已停用');
      const roleResult = await client.query('SELECT id FROM roles WHERE code = $1', [role]);
      if (!roleResult.rows[0]) throw new AdminValidationError('业务角色不存在');
      const existing = await client.query('SELECT id FROM users WHERE lower(email) = $1', [email]);
      if (existing.rows[0]) throw new AdminConflictError('该邮箱已存在，请使用其他邮箱');
      const id = randomUUID();
      await client.query('INSERT INTO users (id, email, display_name, password_hash, department_id, is_active) VALUES ($1, $2, $3, $4, $5, true)', [id, email, displayName, passwordHash, department.rows[0].id]);
      await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [id, roleResult.rows[0].id]);
      await client.query("INSERT INTO organization_members (organization_id, user_id, role, business_role, department_id) VALUES ($1, $2, 'member', $3, $4)", [organizationId, id, role, department.rows[0].id]);
      await this.appendAudit(actorId, 'admin.user.create', 'user', id, requestId, { email, organizationId, departmentCode, role, generatedPassword }, client);
      const result = await client.query(`${USER_SELECT} WHERE u.id = $1`, [id]);
      const user = toUser(result.rows[0]);
      await client.query('COMMIT');
      return { user, initialPassword, generatedPassword };
    } catch (error) {
      await client.query('ROLLBACK');
      const code = (error as { code?: string })?.code;
      if (code === '23505') throw new AdminConflictError('该邮箱已存在，请使用其他邮箱');
      if (code === 'P5501') throw new AdminConflictError('企业可用席位不足，请先增加席位或移除不再使用的成员');
      throw error;
    } finally {
      client.release();
    }
  }

  async getUser(id: string): Promise<AdminUserRecord> {
    const result = await this.pool.query(`${USER_SELECT} WHERE u.id = $1`, [id]);
    if (!result.rows[0]) throw new AdminNotFoundError(`未找到用户：${id}`);
    return toUser(result.rows[0]);
  }

  async updateUser(id: string, patch: AdminUserUpdate, actorId: string, requestId?: string): Promise<AdminUserRecord> {
    await this.getUser(id);
    const sets: string[] = [];
    const values: unknown[] = [];
    let index = 1;
    const push = (column: string, value: unknown) => { sets.push(`${column} = $${index++}`); values.push(value); };

    if (patch.displayName !== undefined) push('display_name', String(patch.displayName));
    if (patch.isActive !== undefined) push('is_active', Boolean(patch.isActive));
    if (patch.password !== undefined) push('password_hash', await hashPassword(String(patch.password)));
    if (patch.departmentCode !== undefined) {
      if (patch.departmentCode === null) {
        push('department_id', null);
      } else {
        const dept = await this.pool.query('SELECT id FROM departments WHERE code = $1', [String(patch.departmentCode)]);
        if (!dept.rows[0]) throw new AdminValidationError(`未找到部门：${patch.departmentCode}`);
        push('department_id', dept.rows[0].id);
      }
    }

    if (sets.length) {
      sets.push('updated_at = now()');
      values.push(id);
      await this.pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${index++}`, values);
    }

    if (patch.role !== undefined) {
      const role = await this.pool.query('SELECT id FROM roles WHERE code = $1', [String(patch.role)]);
      if (!role.rows[0]) throw new AdminValidationError(`未找到角色：${patch.role}`);
      await this.pool.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
      await this.pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [id, role.rows[0].id]);
    }

    await this.appendAudit(actorId, 'admin.user.update', 'user', id, requestId, {
      changed: Object.keys(patch).filter((key) => key !== 'password'),
      passwordReset: patch.password !== undefined,
    });
    return this.getUser(id);
  }

  async listRoles(): Promise<AdminRoleRecord[]> {
    const result = await this.pool.query('SELECT id, code, name FROM roles ORDER BY code');
    return result.rows.map((row) => ({ id: String(row.id), code: String(row.code), name: String(row.name) }));
  }

  async listInterviewerOptions(organizationId?: string): Promise<InterviewerOptionRecord[]> {
    // Never fall back to the global address book if a workspace is missing.
    if (!organizationId) return []
    // Account roles control picker visibility, not workspace permissions.
    const result = await this.pool.query(
      `SELECT u.id, u.display_name, u.email, d.code AS department_code
         FROM organization_members m
         JOIN organizations o ON o.id = m.organization_id AND o.status = 'active'
         JOIN users u ON u.id = m.user_id
         LEFT JOIN departments d ON d.id = m.department_id
        WHERE m.organization_id = $1::uuid AND u.is_active = true
          AND EXISTS (
            SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = u.id AND r.code IN ('hr_admin', 'hiring_manager', 'admin')
          )
        ORDER BY u.display_name, u.email`, [organizationId]
    )
    return result.rows.map((row) => ({
      id: String(row.id),
      displayName: String(row.display_name),
      email: String(row.email),
      departmentCode: row.department_code === null || row.department_code === undefined ? null : String(row.department_code),
    }))
  }

  async listAiPromptSkills(activeOnly = false, targetType?: AiPromptSkillTarget): Promise<AiPromptSkillRecord[]> {
    const conditions: string[] = []
    const values: string[] = []
    if (activeOnly) conditions.push('s.is_active = true')
    if (targetType) {
      values.push(targetType)
      // both 不包括简历评分，不能把写作规则混入评分 Prompt。
      conditions.push(targetType === 'job_spec' || targetType === 'jd'
        ? `(s.target_type = $1 OR s.target_type = 'both')` : 's.target_type = $1')
    }
    if (this.organizationId) { values.push(this.organizationId); conditions.push(`s.organization_id = $${values.length}::uuid`) }
    const result = await this.pool.query(
      `${AI_SKILL_SELECT} ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY s.updated_at DESC, s.name`, values,
    )
    return result.rows.map(toAiPromptSkill)
  }

  async getAiPromptSkill(id: string, activeOnly = false, executor: Pool | PoolClient = this.pool): Promise<AiPromptSkillRecord> {
    if (!UUID_PATTERN.test(id)) throw new AdminValidationError('Skill ID 格式无效')
    const result = await executor.query(`${AI_SKILL_SELECT} WHERE s.id = $1 ${activeOnly ? 'AND s.is_active = true' : ''} ${this.organizationId ? 'AND s.organization_id = $2::uuid' : ''}`, this.organizationId ? [id, this.organizationId] : [id])
    if (!result.rows[0]) throw new AdminNotFoundError(`未找到提示词 Skill：${id}`)
    return toAiPromptSkill(result.rows[0])
  }

  async createAiPromptSkill(input: AiPromptSkillCreate, actorId: string, requestId?: string): Promise<AiPromptSkillRecord> {
    const name = String(input.name ?? '').trim()
    const content = String(input.content ?? '').trim()
    const targetType = input.targetType ?? 'both'
    this.validateAiPromptSkill(name, content, targetType)
    const jobIds = this.validateSkillJobs(targetType, input.jobIds === undefined ? [] : input.jobIds)
    return this.skillTransaction(async (client) => {
      if (this.organizationId) await new EnterpriseAiStore(this.pool).assertAdmin(this.organizationId, actorId, client, true)
      const result = await client.query(
        'INSERT INTO ai_prompt_skills (name, target_type, content, created_by, organization_id) VALUES ($1, $2, $3, $4, $5::uuid) RETURNING id',
        [name, targetType, content, actorId, this.organizationId ?? null],
      )
      const id = String(result.rows[0].id)
      await this.replaceSkillJobs(client, id, jobIds)
      const skill = await this.getAiPromptSkill(id, false, client)
      await this.appendAudit(actorId, 'admin.ai_prompt_skill.create', 'ai_prompt_skill', id, requestId, { name, targetType, jobIds }, client)
      return skill
    })
  }

  async updateAiPromptSkill(id: string, patch: AiPromptSkillUpdate, actorId: string, requestId?: string): Promise<AiPromptSkillRecord> {
    if (!UUID_PATTERN.test(id)) throw new AdminValidationError('Skill ID 格式无效')
    return this.skillTransaction(async (client) => {
      if (this.organizationId) await new EnterpriseAiStore(this.pool).assertAdmin(this.organizationId, actorId, client, true)
      // Serialize edits of the same Skill so omitted fields cannot overwrite another editor's changes.
      await client.query(`SELECT id FROM ai_prompt_skills WHERE id = $1 ${this.organizationId ? 'AND organization_id = $2::uuid' : ''} FOR UPDATE`, this.organizationId ? [id, this.organizationId] : [id])
      const current = await this.getAiPromptSkill(id, false, client)
      const name = patch.name === undefined ? current.name : String(patch.name).trim()
      const content = patch.content === undefined ? current.content : String(patch.content).trim()
      const targetType = patch.targetType ?? current.targetType
      this.validateAiPromptSkill(name, content, targetType)
      if (patch.isActive !== undefined && typeof patch.isActive !== 'boolean') throw new AdminValidationError('Skill 启用状态必须为布尔值')
      const jobIds = this.validateSkillJobs(targetType, patch.jobIds === undefined ? (targetType === 'resume_score' ? current.jobIds : []) : patch.jobIds)
      await this.replaceSkillJobs(client, id, jobIds)
      await client.query(
        'UPDATE ai_prompt_skills SET name = $1, target_type = $2, content = $3, is_active = $4, updated_at = now() WHERE id = $5',
        [name, targetType, content, patch.isActive ?? current.isActive, id],
      )
      const skill = await this.getAiPromptSkill(id, false, client)
      await this.appendAudit(actorId, 'admin.ai_prompt_skill.update', 'ai_prompt_skill', id, requestId, { changed: Object.keys(patch), jobIds }, client)
      return skill
    })
  }

  async deleteAiPromptSkill(id: string, actorId: string, requestId?: string): Promise<void> {
    await this.skillTransaction(async (client) => {
      if (this.organizationId) await new EnterpriseAiStore(this.pool).assertAdmin(this.organizationId, actorId, client, true)
      await this.getAiPromptSkill(id, false, client)
      await client.query('DELETE FROM ai_prompt_skills WHERE id = $1', [id])
      await this.appendAudit(actorId, 'admin.ai_prompt_skill.delete', 'ai_prompt_skill', id, requestId, {}, client)
    })
  }

  private validateAiPromptSkill(name: string, content: string, targetType: string): asserts targetType is AiPromptSkillTarget {
    if (!name || name.length > 80) throw new AdminValidationError('Skill 名称不能为空且不能超过 80 个字符')
    if (!content || content.length > 8000) throw new AdminValidationError('Skill 内容不能为空且不能超过 8000 个字符')
    if (!['job_spec', 'jd', 'both', 'resume_score'].includes(targetType)) throw new AdminValidationError('Skill 适用范围无效')
  }

  private validateSkillJobs(targetType: AiPromptSkillTarget, value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 200 || value.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))) {
      throw new AdminValidationError('适用岗位必须是有效岗位 ID 数组，最多 200 个')
    }
    if (targetType !== 'resume_score' && value.length) throw new AdminValidationError('只有简历评分 Skill 可以关联岗位')
    // Unbound Skills are reusable drafts; deleting a job can also leave a Skill unbound.
    return [...new Set((value as string[]).map((id) => id.toLowerCase()))].sort()
  }

  private async replaceSkillJobs(client: PoolClient, skillId: string, jobIds: string[]): Promise<void> {
    if (jobIds.length) {
      // Job locks plus the unique job_id constraint avoid concurrent double assignment.
      const jobs = await client.query(`SELECT id FROM jobs WHERE id = ANY($1::uuid[]) ${this.organizationId ? 'AND organization_id = $2::uuid' : ''} ORDER BY id FOR UPDATE`, this.organizationId ? [jobIds, this.organizationId] : [jobIds])
      if (jobs.rows.length !== jobIds.length) throw new AdminValidationError('部分适用岗位不存在或已删除，请刷新岗位列表')
      const conflict = await client.query(`SELECT j.title, s.name FROM ai_resume_scoring_skill_jobs b
        JOIN jobs j ON j.id = b.job_id JOIN ai_prompt_skills s ON s.id = b.skill_id
        WHERE b.job_id = ANY($1::uuid[]) AND b.skill_id <> $2 LIMIT 1`, [jobIds, skillId])
      if (conflict.rows[0]) throw new AdminValidationError(this.organizationId ? "岗位已绑定其他评分 Skill，请先解除原关联；历史未归属 Skill 请联系平台管理员处理" : `岗位「${conflict.rows[0].title}」已绑定评分 Skill「${conflict.rows[0].name}」，请先在原 Skill 中解除关联`)
    }
    await client.query('DELETE FROM ai_resume_scoring_skill_jobs WHERE skill_id = $1', [skillId])
    if (jobIds.length) await client.query('INSERT INTO ai_resume_scoring_skill_jobs (skill_id, job_id) SELECT $1::uuid, unnest($2::uuid[])', [skillId, jobIds])
  }

  private async skillTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async listDepartments(activeOnly = false): Promise<AdminDepartmentRecord[]> {
    const result = await this.pool.query(`SELECT id, code, name, is_active, created_at, updated_at FROM departments ${activeOnly ? 'WHERE is_active = true' : ''} ORDER BY name, code`)
    return result.rows.map(toDepartment)
  }

  async createDepartment(input: AdminDepartmentCreate, actorId: string, requestId?: string): Promise<AdminDepartmentRecord> {
    const name = String(input.name ?? '').trim()
    if (!name) throw new AdminValidationError('部门名称不能为空')

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = `dept-${randomUUID().replaceAll('-', '').slice(0, 12)}`
      try {
        const result = await this.pool.query('INSERT INTO departments (code, name, is_active) VALUES ($1, $2, true) RETURNING id, code, name, is_active, created_at, updated_at', [code, name])
        const department = toDepartment(result.rows[0])
        await this.appendAudit(actorId, 'admin.department.create', 'department', department.id, requestId, { code, name })
        return department
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error
      }
    }
    throw new AdminValidationError('系统生成部门编码冲突，请重试')
  }

  async updateDepartment(id: string, patch: AdminDepartmentUpdate, actorId: string, requestId?: string): Promise<AdminDepartmentRecord> {
    const current = await this.pool.query('SELECT id, code, name, is_active, created_at, updated_at FROM departments WHERE id = $1', [id])
    if (!current.rows[0]) throw new AdminNotFoundError(`未找到部门：${id}`)
    const sets: string[] = []
    const values: unknown[] = []
    if (patch.name !== undefined) {
      const name = String(patch.name).trim()
      if (!name) throw new AdminValidationError('部门名称不能为空')
      sets.push(`name = $${values.push(name)}`)
    }
    if (patch.isActive !== undefined) sets.push(`is_active = $${values.push(Boolean(patch.isActive))}`)
    if (!sets.length) return toDepartment(current.rows[0])
    values.push(id)
    const result = await this.pool.query(`UPDATE departments SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING id, code, name, is_active, created_at, updated_at`, values)
    const department = toDepartment(result.rows[0])
    await this.appendAudit(actorId, 'admin.department.update', 'department', department.id, requestId, { changed: Object.keys(patch), code: department.code })
    return department
  }

  /**
   * 物理删除部门。
   *
   * 关联外键的删除动作（见 information_schema.referential_constraints）：
   * - users.department_id / departments.parent_id → SET NULL
   * - department_approval_policies.department_id → CASCADE
   * - jobs.department_id / recruitment_requests.department_id → RESTRICT
   *
   * SET NULL 会静默改写历史归属（用户被解除部门后，hiring_manager 的部门可见范围会退化成全量），
   * RESTRICT 会直接抛 23503。因此这里先把所有会「丢数据」的引用挡在前面，给出可执行的提示，
   * 只有真正没有引用的部门才允许物理删除。审批策略属于部门自身配置，随删除一并清除。
   */
  async deleteDepartment(id: string, actorId: string, requestId?: string): Promise<AdminDepartmentDeleteResult> {
    const current = await this.pool.query('SELECT id, code, name, is_active, created_at, updated_at FROM departments WHERE id = $1', [id])
    if (!current.rows[0]) throw new AdminNotFoundError(`未找到部门：${id}`)
    const department = toDepartment(current.rows[0])

    const blockers = await this.pool.query(
      `SELECT
         (SELECT count(*) FROM users WHERE department_id = $1)::int AS users,
         (SELECT count(*) FROM recruitment_requests WHERE department_id = $1)::int AS requests,
         (SELECT count(*) FROM jobs WHERE department_id = $1)::int AS jobs,
         (SELECT count(*) FROM departments WHERE parent_id = $1)::int AS children`,
      [id]
    )
    const counts = blockers.rows[0] as { users: number; requests: number; jobs: number; children: number }
    const parts: string[] = []
    if (counts.users) parts.push(`${counts.users} 个用户`)
    if (counts.requests) parts.push(`${counts.requests} 个招聘需求`)
    if (counts.jobs) parts.push(`${counts.jobs} 个岗位`)
    if (counts.children) parts.push(`${counts.children} 个子部门`)
    if (parts.length) {
      throw new AdminValidationError(
        `无法删除部门「${department.name}」：仍有 ${parts.join('、')}引用该部门。请先转移这些记录，或改用「停用」。`
      )
    }

    const policies = await this.pool.query('SELECT count(*)::int AS count FROM department_approval_policies WHERE department_id = $1', [id])
    await this.pool.query('DELETE FROM departments WHERE id = $1', [id])
    const removedApprovalPolicies = Number((policies.rows[0] as { count?: number } | undefined)?.count ?? 0)
    await this.appendAudit(actorId, 'admin.department.delete', 'department', department.id, requestId, {
      code: department.code,
      name: department.name,
      removedApprovalPolicies,
    })
    return { id: department.id, code: department.code, name: department.name, removedApprovalPolicies }
  }

  async updateRole(id: string, patch: AdminRoleUpdate, actorId: string, requestId?: string): Promise<AdminRoleRecord> {
    const current = await this.pool.query('SELECT id, code, name FROM roles WHERE id = $1', [id]);
    if (!current.rows[0]) throw new AdminNotFoundError(`未找到角色：${id}`);
    if (patch.name === undefined) return { id, code: current.rows[0].code, name: current.rows[0].name };

    await this.pool.query('UPDATE roles SET name = $1 WHERE id = $2', [String(patch.name), id]);
    await this.appendAudit(actorId, 'admin.role.update', 'role', id, requestId, { name: String(patch.name) });
    return { id, code: String(current.rows[0].code), name: String(patch.name) };
  }

  async getSettings(): Promise<Record<string, unknown>> {
    const result = await this.pool.query('SELECT key, value FROM system_settings ORDER BY key');
    return Object.fromEntries(result.rows.map((row) => [String(row.key), row.value]));
  }

  async updateSettings(patch: Record<string, unknown>, actorId: string, requestId?: string): Promise<Record<string, unknown>> {
    for (const [key, value] of Object.entries(patch)) {
      await this.pool.query(
        `INSERT INTO system_settings (key, value, updated_by)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(value ?? null), actorId]
      );
    }
    await this.appendAudit(actorId, 'admin.settings.update', 'system_settings', null, requestId, { keys: Object.keys(patch) });
    return this.getSettings();
  }

  async getDingTalkSettings(): ReturnType<typeof readDingTalkEnvSettings> {
    return readDingTalkEnvSettings()
  }

  async getDingTalkApprovalConfig(): Promise<DingTalkApprovalConfig> {
    const [departments, users] = await Promise.all([
      this.pool.query(`
        SELECT d.id, d.code, d.name, d.is_active,
               (SELECT m.external_id FROM external_entity_mappings m
                  WHERE m.provider = 'dingtalk' AND m.external_type = 'department'
                    AND m.internal_type = 'department' AND m.internal_id = d.id
                  ORDER BY m.last_synced_at DESC LIMIT 1) AS dingtalk_department_id,
               (SELECT p.process_code FROM department_approval_policies p
                  WHERE p.department_id = d.id AND p.subject_type = 'recruitment_request'
                    AND p.is_active = true LIMIT 1) AS process_code
          FROM departments d
         ORDER BY d.is_active DESC, d.name`),
      this.pool.query(`
        SELECT u.id, u.display_name, u.email, d.name AS department_name,
               (SELECT m.external_id FROM external_entity_mappings m
                  WHERE m.provider = 'dingtalk' AND m.external_type = 'user'
                    AND m.internal_type = 'user' AND m.internal_id = u.id
                  ORDER BY m.last_synced_at DESC LIMIT 1) AS dingtalk_user_id
          FROM users u
          LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.is_active = true
         ORDER BY d.name NULLS LAST, u.display_name`),
    ])
    const callbackBase = process.env.DINGTALK_CALLBACK_BASE_URL?.trim().replace(/\/$/u, '') ?? ''
    const callbackUrl = callbackBase ? `${callbackBase}/api/v1/integrations/dingtalk/approvals/callback` : null
    return {
      subjectType: 'recruitment_request',
      callbackUrl,
      callbackUrlConfigured: Boolean(callbackUrl),
      departments: departments.rows.map((row) => {
        const rawExternalId = row.dingtalk_department_id === null || row.dingtalk_department_id === undefined ? null : Number(row.dingtalk_department_id)
        const departmentId = rawExternalId !== null && Number.isSafeInteger(rawExternalId) ? rawExternalId : null
        const processCode = row.process_code ? String(row.process_code) : null
        return { id: String(row.id), code: String(row.code), name: String(row.name), isActive: Boolean(row.is_active), dingTalkDepartmentId: departmentId, processCode, configured: departmentId !== null && Boolean(processCode) }
      }),
      users: users.rows.map((row) => {
        const dingTalkUserId = row.dingtalk_user_id ? String(row.dingtalk_user_id) : null
        return { id: String(row.id), displayName: String(row.display_name), email: String(row.email), departmentName: row.department_name ? String(row.department_name) : null, dingTalkUserId, configured: Boolean(dingTalkUserId) }
      }),
    }
  }

  async updateDingTalkApprovalConfig(patch: DingTalkApprovalConfigPatch, actorId: string, requestId?: string): Promise<DingTalkApprovalConfig> {
    const departmentId = patch.departmentId?.trim()
    const userId = patch.userId?.trim() ?? ''
    if (!departmentId && !userId) throw new AdminValidationError('departmentId 或 userId 至少提供一个')
    if (departmentId && userId) throw new AdminValidationError('一次只能保存部门审批配置或用户映射')

    if (departmentId) {
      const department = await this.pool.query('SELECT id FROM departments WHERE id = $1', [departmentId])
      if (!department.rows[0]) throw new AdminNotFoundError(`未找到部门：${departmentId}`)
      const processCode = patch.processCode?.trim() ?? ''
      if (processCode.length > 200) throw new AdminValidationError('processCode 不能超过 200 个字符')
      const rawDepartmentId = patch.dingTalkDepartmentId === null || patch.dingTalkDepartmentId === undefined ? '' : String(patch.dingTalkDepartmentId).trim()
      if (rawDepartmentId && (!/^\d+$/u.test(rawDepartmentId) || !Number.isSafeInteger(Number(rawDepartmentId)) || Number(rawDepartmentId) <= 0)) {
        throw new AdminValidationError('钉钉部门 ID 必须是正整数')
      }
      await this.pool.query(`DELETE FROM external_entity_mappings
        WHERE provider = 'dingtalk' AND external_type = 'department' AND internal_type = 'department' AND internal_id = $1`, [departmentId])
      if (rawDepartmentId) {
        await this.pool.query(`INSERT INTO external_entity_mappings
          (provider, external_type, external_id, internal_type, internal_id, metadata)
          VALUES ('dingtalk', 'department', $1, 'department', $2, '{}'::jsonb)
          ON CONFLICT (provider, external_type, external_id) DO UPDATE SET internal_id = EXCLUDED.internal_id, last_synced_at = now()`, [rawDepartmentId, departmentId])
      }
      if (processCode) {
        await this.pool.query(`INSERT INTO department_approval_policies (department_id, subject_type, process_code, is_active)
          VALUES ($1, 'recruitment_request', $2, true)
          ON CONFLICT (department_id, subject_type) DO UPDATE SET process_code = EXCLUDED.process_code, is_active = true, updated_at = now()`, [departmentId, processCode])
      } else {
        await this.pool.query(`DELETE FROM department_approval_policies WHERE department_id = $1 AND subject_type = 'recruitment_request'`, [departmentId])
      }
      await this.appendAudit(actorId, 'admin.dingtalk_approval.department.update', 'department', departmentId, requestId, { configured: Boolean(rawDepartmentId && processCode), processCodeConfigured: Boolean(processCode), departmentMappingConfigured: Boolean(rawDepartmentId) })
    } else {
      const user = await this.pool.query('SELECT id FROM users WHERE id = $1', [userId])
      if (!user.rows[0]) throw new AdminNotFoundError(`未找到用户：${userId}`)
      const dingTalkUserId = patch.dingTalkUserId?.trim() ?? ''
      if (dingTalkUserId.length > 200) throw new AdminValidationError('钉钉 userId 不能超过 200 个字符')
      await this.pool.query(`DELETE FROM external_entity_mappings
        WHERE provider = 'dingtalk' AND external_type = 'user' AND internal_type = 'user' AND internal_id = $1`, [userId])
      if (dingTalkUserId) {
        await this.pool.query(`INSERT INTO external_entity_mappings
          (provider, external_type, external_id, internal_type, internal_id, metadata)
          VALUES ('dingtalk', 'user', $1, 'user', $2, '{}'::jsonb)
          ON CONFLICT (provider, external_type, external_id) DO UPDATE SET internal_id = EXCLUDED.internal_id, last_synced_at = now()`, [dingTalkUserId, userId])
      }
      await this.appendAudit(actorId, 'admin.dingtalk_approval.user.update', 'user', userId, requestId, { configured: Boolean(dingTalkUserId) })
    }
    return this.getDingTalkApprovalConfig()
  }

  async updateDingTalkSettings(patch: DingTalkEnvPatch, actorId: string, requestId?: string): ReturnType<typeof updateDingTalkEnvSettings> {
    const result = await updateDingTalkEnvSettings(resolveEnvFilePath(), patch)
    await this.appendAudit(actorId, 'admin.dingtalk_settings.update', 'env_file', null, requestId, { keys: Object.keys(patch) })
    return result
  }

  /** 只测试 OAuth2 凭据；未提交的新 AppKey/AppSecret 可随请求传入，密钥不会写日志或回传。 */
  testDingTalkConnection(input: { appKey?: string; appSecret?: string } = {}): Promise<DingTalkConnectionTestResult> {
    const testInput: { appKey?: string; appSecret?: string } = {}
    const appKey = input.appKey?.trim() || process.env.DINGTALK_APP_KEY?.trim()
    const appSecret = input.appSecret?.trim() || process.env.DINGTALK_APP_SECRET?.trim()
    if (appKey) testInput.appKey = appKey
    if (appSecret) testInput.appSecret = appSecret
    return testDingTalkConnection(testInput)
  }

  async getResumeVirusScanSetting(): Promise<{ enabled: boolean }> {
    return { enabled: await readResumeVirusScanSetting(resolveEnvFilePath()) }
  }

  async updateResumeVirusScanSetting(enabled: boolean, actorId: string, requestId?: string): Promise<{ enabled: boolean }> {
    const result = await updateResumeVirusScanSetting(resolveEnvFilePath(), enabled)
    await this.appendAudit(actorId, 'admin.resume_virus_scan.update', 'env_file', null, requestId, { enabled })
    return { enabled: result }
  }

  /**
   * 模型连接信息：地址、模型、超时可在后台维护，密钥只返回掩码。
   * 连接状态用于展示当前进程实际生效的配置。
   */
  async getAiSettings(): Promise<AiSettingsResponse> {
    return { ...readAiSettings(), env: await readAiEnvSettings(resolveEnvFilePath()) }
  }

  async updateAiSettings(patch: AiEnvPatch, actorId: string, requestId?: string): Promise<AiSettingsResponse> {
    const env = await updateAiEnvSettings(resolveEnvFilePath(), patch)
    await this.appendAudit(actorId, 'admin.ai_settings.update', 'env_file', null, requestId, { keys: Object.keys(patch) })
    return { ...readAiSettings(), env }
  }

  /** 用给定（或当前生效）的连接拉取模型列表，供「先测试再保存模型」使用。 */
  testAiConnection(input: AiConnectionTestInput = {}): Promise<AiConnectionTestResult> {
    return testAiConnection(input)
  }

  async getChannelSettings(): Promise<ChannelSettings> {
    return readChannelSettings(this.envFilePath)
  }

  async updateChannelSettings(patch: Record<string, string>, actorId: string, requestId?: string): Promise<ChannelSettings> {
    const result = await updateChannelSettings(this.envFilePath, patch)
    await this.appendAudit(actorId, 'admin.channel_settings.update', 'env_file', null, requestId, { keys: Object.keys(patch) })
    return result
  }

  async testChannelConnection(provider: ChannelProvider) {
    const settings = await this.getChannelSettings()
    if (!settings[provider]) throw new AdminValidationError(`未知招聘渠道：${provider}`)
    const input = await readChannelConnectionInput(this.envFilePath, provider)
    return createChannelConnector(provider).test(input)
  }

  async listAuditLogs(limit = 50): Promise<AdminAuditRecord[]> {
    const bounded = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 50, 200));
    const result = await this.pool.query(`${AUDIT_SELECT} ORDER BY a.created_at DESC LIMIT $1`, [bounded]);
    return result.rows.map(toAudit);
  }

  private async appendAudit(
    actorId: string,
    action: string,
    resourceType: string,
    resourceId: string | null,
    requestId: string | undefined,
    metadata: Record<string, unknown>,
    executor: Pool | PoolClient = this.pool,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, request_id, metadata, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, COALESCE($7::uuid, '00000000-0000-4000-8000-000000000028'::uuid))`,
      [actorId, action, resourceType, resourceId, requestId ?? null, JSON.stringify(metadata), this.organizationId ?? null]
    );
  }
}

export class AdminConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) { super(message); this.name = 'AdminConflictError'; }
}

export class AdminNotFoundError extends Error {
  readonly code = 'ADMIN_NOT_FOUND';
  readonly status = 404;
  constructor(message: string) { super(message); this.name = 'AdminNotFoundError'; }
}

export class AdminValidationError extends Error {
  readonly code = 'ADMIN_VALIDATION_ERROR';
  readonly status = 400;
  constructor(message: string) { super(message); this.name = 'AdminValidationError'; }
}

