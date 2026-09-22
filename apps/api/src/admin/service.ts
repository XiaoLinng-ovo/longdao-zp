import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { hashPassword } from '../auth/password.js';
import { readDingTalkEnvSettings, readResumeVirusScanSetting, updateDingTalkEnvSettings, updateResumeVirusScanSetting, type DingTalkEnvPatch } from './dingtalk-env-settings.js';
import { readAiEnvSettings, readAiSettings, testAiConnection, updateAiEnvSettings, type AiConnectionTestInput, type AiConnectionTestResult, type AiEnvPatch, type AiSettingsResponse } from './ai-settings.js';
import { resolveEnvFilePath } from './env-file.js';
import { readChannelConnectionInput, readChannelSettings, updateChannelSettings, type ChannelSettings } from '../integrations/channels/settings.js';
import { createChannelConnector } from '../integrations/channels/registry.js';
import type { ChannelProvider } from '../integrations/channels/types.js';

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

export interface AdminRoleUpdate {
  name?: string;
}


export type AiPromptSkillTarget = 'job_spec' | 'jd' | 'both'

export interface AiPromptSkillRecord {
  id: string
  name: string
  targetType: AiPromptSkillTarget
  content: string
  isActive: boolean
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface AiPromptSkillCreate {
  name?: string
  targetType?: AiPromptSkillTarget
  content?: string
}

export interface AiPromptSkillUpdate {
  name?: string
  targetType?: AiPromptSkillTarget
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
    isActive: Boolean(row.is_active),
    createdBy: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  }
}

/**
 * 管理后台服务：用户/角色/系统设置/审计日志的查询与维护。
 * 只做管理域操作，不触碰招聘领域状态机；写操作都会写 audit_logs（系统审计），
 * 与业务链路的 workflow_events（领域事件）区分开。
 */
export class AdminService {
  constructor(private readonly pool: Pool, private readonly envFilePath?: string) {}

  async listUsers(): Promise<AdminUserRecord[]> {
    const result = await this.pool.query(`${USER_SELECT} ORDER BY u.created_at DESC, u.email`);
    return result.rows.map(toUser);
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

  async listInterviewerOptions(): Promise<InterviewerOptionRecord[]> {
    const result = await this.pool.query(
      `SELECT u.id, u.display_name, u.email, d.code AS department_code
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.is_active = true
        ORDER BY u.display_name, u.email`
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
    if (activeOnly) conditions.push('is_active = true')
    if (targetType) {
      values.push(targetType)
      conditions.push(`(target_type = $${values.length} OR target_type = 'both')`)
    }
    const result = await this.pool.query(
      `SELECT id, name, target_type, content, is_active, created_by, created_at, updated_at
         FROM ai_prompt_skills
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY updated_at DESC, name`,
      values,
    )
    return result.rows.map(toAiPromptSkill)
  }

  async getAiPromptSkill(id: string, activeOnly = false): Promise<AiPromptSkillRecord> {
    const result = await this.pool.query(
      `SELECT id, name, target_type, content, is_active, created_by, created_at, updated_at
         FROM ai_prompt_skills
        WHERE id = $1 ${activeOnly ? 'AND is_active = true' : ''}`,
      [id],
    )
    if (!result.rows[0]) throw new AdminNotFoundError(`未找到提示词 Skill：${id}`)
    return toAiPromptSkill(result.rows[0])
  }

  async createAiPromptSkill(input: AiPromptSkillCreate, actorId: string, requestId?: string): Promise<AiPromptSkillRecord> {
    const name = String(input.name ?? '').trim()
    const content = String(input.content ?? '').trim()
    const targetType = input.targetType ?? 'both'
    this.validateAiPromptSkill(name, content, targetType)
    const result = await this.pool.query(
      `INSERT INTO ai_prompt_skills (name, target_type, content, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, target_type, content, is_active, created_by, created_at, updated_at`,
      [name, targetType, content, actorId],
    )
    const skill = toAiPromptSkill(result.rows[0])
    await this.appendAudit(actorId, 'admin.ai_prompt_skill.create', 'ai_prompt_skill', skill.id, requestId, { name, targetType })
    return skill
  }

  async updateAiPromptSkill(id: string, patch: AiPromptSkillUpdate, actorId: string, requestId?: string): Promise<AiPromptSkillRecord> {
    const current = await this.getAiPromptSkill(id)
    const name = patch.name === undefined ? current.name : String(patch.name).trim()
    const content = patch.content === undefined ? current.content : String(patch.content).trim()
    const targetType = patch.targetType === undefined ? current.targetType : patch.targetType
    this.validateAiPromptSkill(name, content, targetType)
    const result = await this.pool.query(
      `UPDATE ai_prompt_skills
          SET name = $1, target_type = $2, content = $3, is_active = $4, updated_at = now()
        WHERE id = $5
        RETURNING id, name, target_type, content, is_active, created_by, created_at, updated_at`,
      [name, targetType, content, patch.isActive === undefined ? current.isActive : Boolean(patch.isActive), id],
    )
    const skill = toAiPromptSkill(result.rows[0])
    await this.appendAudit(actorId, 'admin.ai_prompt_skill.update', 'ai_prompt_skill', id, requestId, { changed: Object.keys(patch) })
    return skill
  }

  async deleteAiPromptSkill(id: string, actorId: string, requestId?: string): Promise<void> {
    await this.getAiPromptSkill(id)
    await this.pool.query('DELETE FROM ai_prompt_skills WHERE id = $1', [id])
    await this.appendAudit(actorId, 'admin.ai_prompt_skill.delete', 'ai_prompt_skill', id, requestId, {})
  }

  private validateAiPromptSkill(name: string, content: string, targetType: string): asserts targetType is AiPromptSkillTarget {
    if (!name || name.length > 80) throw new AdminValidationError('Skill 名称不能为空且不能超过 80 个字符')
    if (!content || content.length > 8000) throw new AdminValidationError('Skill 内容不能为空且不能超过 8000 个字符')
    if (targetType !== 'job_spec' && targetType !== 'jd' && targetType !== 'both') throw new AdminValidationError('Skill 适用范围无效')
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

  async updateDingTalkSettings(patch: DingTalkEnvPatch, actorId: string, requestId?: string): ReturnType<typeof updateDingTalkEnvSettings> {
    const result = await updateDingTalkEnvSettings(resolveEnvFilePath(), patch)
    await this.appendAudit(actorId, 'admin.dingtalk_settings.update', 'env_file', null, requestId, { keys: Object.keys(patch) })
    return result
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
    metadata: Record<string, unknown>
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, request_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [actorId, action, resourceType, resourceId, requestId ?? null, JSON.stringify(metadata)]
    );
  }
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
