import type { WorkspaceSchemaRegistry } from './workspace-context.js'

export async function assertSingleEnterprise(db: WorkspaceSchemaRegistry, userId: string, targetId?: string) {
  const user = await db.query('SELECT id FROM public.users WHERE id=$1 AND is_active=true FOR UPDATE', [userId])
  if (!user.rows[0]) throw Object.assign(new Error('账号不可用，请重新登录'), { code:'AUTHENTICATION_REQUIRED', status:401 })
  const bindings = await db.query('SELECT organization_id,is_active FROM public.organization_members WHERE user_id=$1 AND ended_at IS NULL', [userId])
  if (bindings.rows.length > 1 || bindings.rows.some(row => row.organization_id !== targetId)) {
    throw Object.assign(new Error('此账号已绑定企业，请先由原企业管理员办理退出后再加入或创建其他企业'), { code:'ACCOUNT_ALREADY_BOUND', status:409 })
  }
}
