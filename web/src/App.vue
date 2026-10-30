<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppShell from './app/layout/AppShell.vue'
import WorkspaceContextBoundary from './shared/components/WorkspaceContextBoundary.vue'
import { authSession, refreshAuthSession } from './modules/auth/session'
import { backgroundAudio } from './modules/interviews/utils/background-audio'
import { WORKSPACE_CONTEXT_EVENT, WORKSPACE_CONTEXT_STORAGE_KEY } from './shared/api/workspace-context'

const route = useRoute()
const showShell = computed(() => !route.meta.hideShell && !(route.name === 'workspaces' && !authSession.user?.workspaceId))

function warnPendingAudio(event: BeforeUnloadEvent) {
  if (!backgroundAudio.jobs.some(job => job.phase !== 'completed')) return
  event.preventDefault()
  event.returnValue = ''
}
function retryAudio() { backgroundAudio.retry() }
function suspendAudio() { backgroundAudio.suspend() }
function storageChanged(event: StorageEvent) {
  if (event.key === WORKSPACE_CONTEXT_STORAGE_KEY && event.newValue) suspendAudio()
}
watch(() => [authSession.user?.id, authSession.user?.workspaceId, authSession.sessionId], () => {
  void backgroundAudio.recover().catch(() => undefined)
}, { immediate: true, flush: 'post' })
onMounted(() => {
  window.addEventListener('beforeunload', warnPendingAudio)
  window.addEventListener('online', retryAudio)
  window.addEventListener(WORKSPACE_CONTEXT_EVENT, suspendAudio)
  window.addEventListener('storage', storageChanged)
  void refreshAuthSession()
})
onUnmounted(() => {
  window.removeEventListener('beforeunload', warnPendingAudio)
  window.removeEventListener('online', retryAudio)
  window.removeEventListener(WORKSPACE_CONTEXT_EVENT, suspendAudio)
  window.removeEventListener('storage', storageChanged)
})
</script>

<template>
  <WorkspaceContextBoundary>
    <AppShell v-if="showShell" />
    <router-view v-else />
  </WorkspaceContextBoundary>
</template>
