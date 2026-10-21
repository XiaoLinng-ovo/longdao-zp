export const businessRoleLabels: Record<string, string> = {
  recruiter: '招聘专员', hiring_manager: '部门负责人', approver: '录用审批人', interviewer: '面试官', admin: '系统管理员', hr_admin: 'HR 管理员',
}
export const membershipLabels: Record<string, string> = { owner: '企业所有者', admin: '企业管理员', member: '普通成员' }
export function extractInvitationCode(input: string): string {
  const trimmed = input.trim()
  let code = trimmed
  try { code = new URL(trimmed).searchParams.get('invite') ?? trimmed } catch { /* Plain code. */ }
  return code.replace(/[\s-]/g, '').toUpperCase()
}
export function invitationLink(code: string, origin = window.location.origin): string {
  const url = new URL('/workspaces', origin)
  url.searchParams.set('invite', code)
  return url.toString()
}
export function invitationText(input: { workspaceName: string; code?: string; expiresAt: string }): string {
  return '邀请你加入「' + input.workspaceName + '」\n邀请码：' + input.code + '\n加入链接：' + invitationLink(input.code ?? '') + '\n有效期至：' + new Date(input.expiresAt).toLocaleString('zh-CN') + '\n请使用自己的邮箱注册或登录，邀请码仅用于加入企业，不是登录密码。'
}
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return } catch { /* Older browsers / permission denied: try manual fallback. */ }
  }
  const input = document.createElement('textarea')
  input.value = text; input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0'
  document.body.appendChild(input)
  try { input.select(); if (!document.execCommand('copy')) throw new Error('浏览器不允许自动复制，请选中邀请码手动复制') } finally { input.remove() }
}
