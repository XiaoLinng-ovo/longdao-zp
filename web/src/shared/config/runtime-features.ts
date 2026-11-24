import { reactive } from 'vue'
import { apiClient } from '../api'

interface RuntimeFeatures {
  loaded: boolean
  loading: boolean
  sessionKey: string
  recruitmentReportsEnabled: boolean
}

export const runtimeFeatures = reactive<RuntimeFeatures>({
  loaded: false,
  loading: false,
  sessionKey: '',
  recruitmentReportsEnabled: false,
})

let pendingLoad: Promise<void> | undefined
let loadVersion = 0

export async function loadRuntimeFeatures(sessionKey: string, force = false): Promise<void> {
  if (!sessionKey) {
    loadVersion += 1
    runtimeFeatures.loaded = false
    runtimeFeatures.loading = false
    runtimeFeatures.sessionKey = ''
    runtimeFeatures.recruitmentReportsEnabled = false
    return
  }
  if (!force && runtimeFeatures.loaded && runtimeFeatures.sessionKey === sessionKey) return
  if (!force && runtimeFeatures.loading && runtimeFeatures.sessionKey === sessionKey) return pendingLoad

  const version = ++loadVersion
  runtimeFeatures.loading = true
  runtimeFeatures.sessionKey = sessionKey
  const request = (async () => {
    try {
      const result = await apiClient.getJson<{ recruitmentReportsEnabled: boolean }>('/system/features')
      if (version === loadVersion) {
        runtimeFeatures.recruitmentReportsEnabled = result.data.recruitmentReportsEnabled === true
        runtimeFeatures.loaded = true
      }
    } catch {
      // Feature availability is fail-closed in the browser. The API also enforces this.
      if (version === loadVersion) {
        runtimeFeatures.recruitmentReportsEnabled = false
        runtimeFeatures.loaded = false
      }
    } finally {
      if (version === loadVersion) {
        runtimeFeatures.loading = false
        pendingLoad = undefined
      }
    }
  })()
  pendingLoad = request
  await request
}
