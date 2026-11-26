<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import SidebarNav from './SidebarNav.vue'
import TopBar from './TopBar.vue'
import BackgroundInterviewUploads from '../../modules/interviews/components/BackgroundInterviewUploads.vue'
import TrialQuotaBanner from '../../shared/components/TrialQuotaBanner.vue'
import { authSession } from '../../modules/auth/session'
const route = useRoute()
const title = computed(() => String(route.meta.title ?? '招聘工作台'))
const crumb = computed(() => String(route.meta.crumb ?? `首页 / ${title.value}`))
const browsingCandidates = computed(() => route.name === 'candidates' || route.name === 'candidate-detail')
const candidateCacheKey = computed(() => JSON.stringify([authSession.sessionId, authSession.user?.id, authSession.user?.workspaceId]))
watch(title, (value) => { document.title = `${value} | 招聘管理` }, { immediate: true })
</script>
<template>
  <div class="app-shell">
    <SidebarNav />
    <div class="app-main">
      <TopBar :title="title" :crumb="crumb" />
      <BackgroundInterviewUploads />
      <main class="page-content">
        <TrialQuotaBanner v-if="authSession.user?.workspaceId" />
        <router-view v-slot="{ Component }">
          <KeepAlive v-if="browsingCandidates" :key="candidateCacheKey" include="CandidateListPage" :max="1">
            <component :is="Component" />
          </KeepAlive>
          <component :is="Component" v-else />
        </router-view>
      </main>
    </div>
  </div>
</template>
