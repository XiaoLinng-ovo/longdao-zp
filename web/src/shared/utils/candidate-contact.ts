export function candidateSourceLabel(source?: string): string {
  const value = source?.trim() ?? ''
  if (!value) return '未标注'
  if (/^resume-import(?::|$)/iu.test(value)) return '批量导入'
  const labels: Record<string, string> = {
    manual: '手动录入', referral: '内部推荐', website: '官网投递', import: '简历导入',
    boss: 'BOSS 直聘', liepin: '猎聘', zhilian: '智联招聘', lagou: '拉勾招聘',
  }
  return labels[value] ?? (/^[\w-]+:\S+$/u.test(value) ? '其他渠道' : value)
}

export function emailHref(value?: string): string | undefined {
  const email = value?.trim() ?? ''
  return /^[^\s@<>?&#]+@[^\s@<>?&#]+\.[^\s@<>?&#]+$/u.test(email) ? 'mailto:' + encodeURIComponent(email).replace('%40', '@') : undefined
}

export function phoneHref(value?: string): string | undefined {
  const phone = value?.trim().replace(/[\s()-]/gu, '') ?? ''
  return /^\+?\d{3,20}$/u.test(phone) ? 'tel:' + phone : undefined
}
