// Kept independent of the auth store to avoid auth -> API client -> auth cycles.
let workspaceId: string | undefined
let revision = 0
let identity: string | undefined
export const WORKSPACE_CONTEXT_EVENT = 'smartrecruit:workspace-context-invalidated'
export const WORKSPACE_CONTEXT_STORAGE_KEY = 'smartrecruit:workspace-context-change'

export function getWorkspaceContext() { return { workspaceId, revision } }

export function setWorkspaceContext(id: string | undefined, userIdentity?: string) {
  if (workspaceId === id && identity === userIdentity) return
  workspaceId = id
  identity = userIdentity
  revision += 1
}

export function notifyOtherTabs() {
  try {
    // No credentials or personal data are broadcast. A unique value also detects A -> B -> A.
    window.localStorage.setItem(WORKSPACE_CONTEXT_STORAGE_KEY, `${Date.now()}-${Math.random()}`)
  } catch { /* The server header guard still protects tabs when storage is unavailable. */ }
}

export function invalidateWorkspaceContext() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(WORKSPACE_CONTEXT_EVENT))
}
