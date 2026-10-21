import { assertDevelopmentSeedAllowed, seedDevelopmentData } from './lib/dev-seed.mjs'
// Requires explicit development authorization before loading configuration or database code.

// Development fixture defaults. Existing records are never overwritten.
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

try {
  assertDevelopmentSeedAllowed()
  await import('../apps/api/dist/src/env.js')
  assertDevelopmentSeedAllowed()
  const passwordOverride = process.env.SEED_PASSWORD?.trim()
  const { loadDatabaseConfig, createDatabasePool } = await import('../apps/api/dist/src/db/index.js')
  const { hashPassword } = await import('../apps/api/dist/src/auth/password.js')
  const pool = createDatabasePool(loadDatabaseConfig())
  try {
    const summary = await seedDevelopmentData(pool, {
      departments: DEFAULT_DEPARTMENTS,
      roles: DEFAULT_ROLES,
      users: DEFAULT_USERS,
      hashPassword,
      passwordOverride,
    })
    console.log(`Development seed complete: ${JSON.stringify(summary)}`)
  } finally {
    await pool.end()
  }
} catch (error) {
  console.error(error?.code === 'DEV_SEED_NOT_AUTHORIZED'
    ? error.message
    : 'Development seed failed. No credentials or account details are logged.')
  process.exitCode = 1
}
