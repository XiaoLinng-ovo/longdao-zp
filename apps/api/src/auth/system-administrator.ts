import { HttpError } from '../http.js'
import type { AuthContext, SessionUser } from './types.js'

// Bind one existing immutable account code, never an email, workspace role or client flag.
export function isSystemAdministrator(user: SessionUser, env: NodeJS.ProcessEnv = process.env): boolean {
  const account = env.SYSTEM_ADMIN_USER_NO?.trim()
  return Boolean(account && /^USR-[A-F0-9]{10}$/.test(account) && user.userNo === account)
}

export function requireSystemAdministrator(auth: AuthContext | undefined): void {
  if (!auth || auth.method !== 'session') throw new HttpError(401, 'AUTHENTICATION_REQUIRED', '请登录后访问系统配置')
  if (auth.user.isSystemAdmin !== true) throw new HttpError(403, 'SYSTEM_ADMIN_REQUIRED', '仅系统管理员可以访问系统配置')
}

const configurationPaths = [
  'users', 'account-organizations', 'departments', 'roles', 'settings',
  'dingtalk-settings', 'dingtalk-connection-test', 'smtp-settings',
  'smtp-connection-test', 'smtp-test-email', 'resume-virus-scan',
  'ai-settings', 'ai-connection-test', 'channel-settings', 'channel-connections', 'audit-logs',
  'ai-sharing', 'platform-operators', 'email-deliveries', 'operational-recovery',
]

export function isSystemAdministrationPath(path: string): boolean {
  if (path === '/api/v1/platform/payments' || path.startsWith('/api/v1/platform/payments/')) return true
  return configurationPaths.some(name => path === `/api/v1/admin/${name}` || path.startsWith(`/api/v1/admin/${name}/`))
}
