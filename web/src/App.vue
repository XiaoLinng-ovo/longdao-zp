<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import AppShell from './app/layout/AppShell.vue'
import WorkspaceContextBoundary from './shared/components/WorkspaceContextBoundary.vue'
import { authSession, refreshAuthSession } from './modules/auth/session'

const route = useRoute()
const showShell = computed(() => !route.meta.hideShell && !(route.name === 'workspaces' && !authSession.user?.workspaceId))

onMounted(refreshAuthSession)
</script>

<template>
  <WorkspaceContextBoundary>
    <AppShell v-if="showShell" />
    <router-view v-else />
  </WorkspaceContextBoundary>
</template>
