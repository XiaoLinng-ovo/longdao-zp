export type LiveSessionAction = 'segments' | 'end' | 'question'

export function parseLiveSessionPath(path: string): { sessionId: string; action?: LiveSessionAction } | undefined {
  const prefix = '/api/v1/interview-live-sessions/'
  if (!path.startsWith(prefix)) return undefined
  const parts = path.slice(prefix.length).split('/')
  if (!parts[0] || parts.length > 2) return undefined
  if (parts.length === 1) return { sessionId: parts[0] }
  const action = parts[1]
  if (action !== 'segments' && action !== 'end' && action !== 'question') return undefined
  return { sessionId: parts[0], action }
}
