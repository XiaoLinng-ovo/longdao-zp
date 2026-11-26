type EnterpriseSessionUser = {
  workspaceId?: string | null
}

/** 企业招聘页面只需要确认当前账号已进入企业空间。 */
export function isEnterpriseUser(user?: EnterpriseSessionUser | null): boolean {
  return Boolean(user?.workspaceId?.trim())
}
