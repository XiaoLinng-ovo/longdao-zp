import type { Pool } from 'pg';
import { hashPassword } from '../auth/password.js';
import { readDingTalkEnvSettings, readResumeVirusScanSetting, resolveEnvFilePath, updateDingTalkEnvSettings, updateResumeVirusScanSetting, type DingTalkEnvPatch } from './dingtalk-env-settings.js';

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

export interface AdminDepartmentRecord {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDepartmentCreate { code?: string; name?: string }
export interface AdminDepartmentUpdate { name?: string; isActive?: boolean }

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

/**
 * 管理后台服务：用户/角色/系统设置/审计日志的查询与维护。
 * 只做管理域操作，不触碰招聘领域状态机；写操作都会写 audit_logs（系统审计），
 * 与业务链路的 workflow_events（领域事件）区分开。
 */
export class AdminService {
  constructor(private readonly pool: Pool) {}

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

  async listDepartments(activeOnly = false): Promise<AdminDepartmentRecord[]> {
    const result = await this.pool.query(`SELECT id, code, name, is_active, created_at, updated_at FROM departments ${activeOnly ? 'WHERE is_active = true' : ''} ORDER BY name, code`)
    return result.rows.map(toDepartment)
  }

  async createDepartment(input: AdminDepartmentCreate, actorId: string, requestId?: string): Promise<AdminDepartmentRecord> {
    const code = String(input.code ?? '').trim()
    const name = String(input.name ?? '').trim()
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(code)) throw new AdminValidationError('部门编码必须是 3-64 位小写字母、数字或短横线')
    if (!name) throw new AdminValidationError('部门名称不能为空')
    try {
      const result = await this.pool.query('INSERT INTO departments (code, name, is_active) VALUES ($1, $2, true) RETURNING id, code, name, is_active, created_at, updated_at', [code, name])
      const department = toDepartment(result.rows[0])
      await this.appendAudit(actorId, 'admin.department.create', 'department', department.id, requestId, { code, name })
      return department
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new AdminValidationError(`部门编码已存在：${code}`)
      throw error
    }
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
