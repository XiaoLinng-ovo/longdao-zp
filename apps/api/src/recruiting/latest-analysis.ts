/** Select by timestamps, not repository iteration order. Equal timestamps use a stable ID tie-breaker. */
export function latestAnalysisByKey<T extends { id: string; createdAt: string }>(rows: readonly T[], keyOf: (row: T) => string | null | undefined): Map<string, T> {
  const latest = new Map<string, T>()
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) continue
    const current = latest.get(key)
    const timestamp = Date.parse(row.createdAt)
    const currentTimestamp = current ? Date.parse(current.createdAt) : Number.NEGATIVE_INFINITY
    if (!current || timestamp > currentTimestamp || (timestamp === currentTimestamp && row.id > current.id)) latest.set(key, row)
  }
  return latest
}
