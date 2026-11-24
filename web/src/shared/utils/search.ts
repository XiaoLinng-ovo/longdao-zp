/** Normalize user-entered searchable text without broad fuzzy matching. */
export function normalizeSearchText(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').toLocaleLowerCase('zh-CN') : ''
}
