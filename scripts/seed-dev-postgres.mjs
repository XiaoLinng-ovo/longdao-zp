// 开发种子数据：部门 / 角色 / 初始账号。可重复执行（幂等 upsert）。
// 用法：DATABASE_URL='postgresql://...' node scripts/seed-dev-postgres.mjs
// 说明：生产环境不会自动建账号，本脚本只用于本地开发与验证环境。
import { loadDatabaseConfig, createDatabasePool } from '../apps/api/dist/src/db/index.js'
import { hashPassword } from '../apps/api/dist/src/auth/password.js'

// ===== 可调参数（改这里即可裸跑，也可用环境变量覆盖）=====
const OVERRIDE_PASSWORD = process.env.SEED_PASSWORD?.trim()
const DEFAULT_DEPARTMENTS = [
  { code: 'dept-tech', name: '技术部', parent: null },
  { code: 'dept-hr', name: '人力资源部', parent: null },
  { code: 'dept-sales', name: '销售部', parent: null },
]
const DEFAULT_ROLES = [
  { code: 'recruiter', name: '招聘专员' },
  { code: 'hiring_manager', name: '用人经理' },
  { code: 'approver', name: '审批人' },
  { code: 'admin', name: '系统管理员' },
  { code: 'hr_admin', name: 'HR 管理员' },
  { code: 'interviewer', name: '面试官' },
]
const DEFAULT_USERS = [
  { email: 'recruiter@smartrecruit.local', name: '招聘专员', role: 'recruiter', department: 'dept-tech', password: 'recruiter123' },
  { email: 'manager@smartrecruit.local', name: '技术用人经理', role: 'hiring_manager', department: 'dept-tech', password: 'manager123' },
  { email: 'approver@smartrecruit.local', name: '审批人', role: 'approver', department: 'dept-hr', password: 'approver123' },
  { email: 'hr-admin@smartrecruit.local', name: 'HR 管理员', role: 'hr_admin', department: 'dept-hr', password: 'hr123' },
  { email: 'admin@smartrecruit.local', name: '系统管理员', role: 'admin', department: 'dept-hr', password: 'admin123' },
  { email: 'interviewer@smartrecruit.local', name: '技术面试官', role: 'interviewer', department: 'dept-tech', password: 'interviewer123' },
]

const config = loadDatabaseConfig()
const pool = createDatabasePool(config)
const summary = { departments: 0, roles: 0, users: 0, roleBindings: 0 }

try {
  for (const department of DEFAULT_DEPARTMENTS) {
    await pool.query(
      `INSERT INTO departments (code, name) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, is_active = true`,
      [department.code, department.name],
    )
    summary.departments += 1
  }

  for (const role of DEFAULT_ROLES) {
    await pool.query(
      `INSERT INTO roles (code, name) VALUES ($1, $2) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
      [role.code, role.name],
    )
    summary.roles += 1
  }

  for (const user of DEFAULT_USERS) {
    const passwordHash = await hashPassword(OVERRIDE_PASSWORD || user.password)
    const result = await pool.query(
      `INSERT INTO users (email, display_name, password_hash, department_id, is_active)
       VALUES ($1, $2, $3, (SELECT id FROM departments WHERE code = $4), true)
       ON CONFLICT (email) DO UPDATE
         SET display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash, is_active = true
       RETURNING id`,
      [user.email, user.name, passwordHash, user.department],
    )
    const userId = result.rows[0]?.id
    if (!userId) throw new Error(`无法创建账号：${user.email}`)
    await pool.query('DELETE FROM user_roles WHERE user_id = $1::uuid', [userId])
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1::uuid, id FROM roles WHERE code = $2`,
      [userId, user.role],
    )
    summary.users += 1
    summary.roleBindings += 1
  }

  console.log(`种子完成：${config.target}`)
  console.log(`  部门 ${summary.departments} 个 / 角色 ${summary.roles} 个 / 账号 ${summary.users} 个（已绑定角色 ${summary.roleBindings}）`)
  console.log(`  登录密码：默认与本地开发账号一致（可用 SEED_PASSWORD 统一覆盖）`)
  for (const user of DEFAULT_USERS) console.log(`  - ${user.email}  角色=${user.role}  部门=${user.department}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await pool.end()
}
