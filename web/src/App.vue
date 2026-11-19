<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppShell from './app/layout/AppShell.vue'
import WorkspaceContextBoundary from './shared/components/WorkspaceContextBoundary.vue'
import { authSession } from './modules/auth/session'
import { loadRuntimeFeatures } from './shared/config/runtime-features'
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
function retrySession() { window.location.reload() }
function suspendAudio() { backgroundAudio.suspend() }
function storageChanged(event: StorageEvent) {
  if (event.key === WORKSPACE_CONTEXT_STORAGE_KEY && event.newValue) suspendAudio()
}
watch(() => [authSession.user?.id, authSession.user?.workspaceId, authSession.sessionId], () => {
  void backgroundAudio.recover().catch(() => undefined)
  void loadRuntimeFeatures(authSession.user ? `${authSession.sessionId}:${authSession.user.id}` : '')
}, { immediate: true, flush: 'post' })
onMounted(() => {
  window.addEventListener('beforeunload', warnPendingAudio)
  window.addEventListener('online', retryAudio)
  window.addEventListener(WORKSPACE_CONTEXT_EVENT, suspendAudio)
  window.addEventListener('storage', storageChanged)
})
onUnmounted(() => {
  window.removeEventListener('beforeunload', warnPendingAudio)
  window.removeEventListener('online', retryAudio)
  window.removeEventListener(WORKSPACE_CONTEXT_EVENT, suspendAudio)
  window.removeEventListener('storage', storageChanged)
})
</script>

<template>
  <main v-if="authSession.error && !authSession.user" class="session-retry" role="alert">
    <h1>暂时无法确认登录状态</h1>
    <p>{{ authSession.error }}</p>
    <button class="btn btn-primary" type="button" @click="retrySession">重新连接</button>
  </main>
  <WorkspaceContextBoundary v-else>
    <AppShell v-if="showShell" />
    <router-view v-else />
  </WorkspaceContextBoundary>
</template>

<style scoped>
.session-retry { display: grid; justify-items: center; align-content: center; gap: 16px; min-height: 100dvh; padding: 24px; text-align: center; }
.session-retry h1 { margin: 0; font-size: 22px; }
.session-retry p { margin: 0; }
</style>
