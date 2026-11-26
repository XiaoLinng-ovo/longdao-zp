<script setup lang="ts">
import { computed } from 'vue'
import { RefreshCw, X } from '@lucide/vue'
import { authSession } from '../../auth/session'
import { backgroundAudio } from '../utils/background-audio'

const jobs = computed(() => {
  const user = authSession.user
  const owner = user?.workspaceId && user.id ? user.workspaceId + ':' + user.id : ''
  return backgroundAudio.jobs.filter(job => owner && job.scope === owner + ':' + job.interviewId)
})
</script>

<template>
  <div v-if="jobs.length" class="background-audio" aria-label="面试录音后台保存">
    <div v-for="job in jobs" :key="job.id" class="background-audio-row" :class="{ failed: job.phase === 'failed' }" role="status">
      <router-link :to="{ path: '/interviews/' + job.interviewId + (job.phase === 'processing' ? '/live' : ''), query: ['completed','review_required'].includes(job.phase) ? { openSummary: '1' } : {} }">{{ job.label }}</router-link>
      <span v-if="job.phase === 'completed'">录音已保存，会话已结束</span>
      <span v-else-if="job.phase === 'ending'">录音已保存，正在结束会话</span>
      <span v-else-if="job.phase === 'processing' || job.phase === 'review_required'">{{ job.message }}</span>
      <span v-else-if="job.phase === 'failed'">{{ job.message }}<template v-if="job.pending">（待上传 {{ job.pending }} 段）</template></span>
      <span v-else>后台保存中，待上传 {{ job.pending }} 段</span>
      <span v-if="job.phase === 'completed' && job.message" class="cache-warning">{{ job.message }}</span>
      <span v-if="job.cacheWarning" class="cache-warning">{{ job.cacheWarning }}</span>
      <button v-if="job.phase === 'failed'" class="btn btn-ghost btn-sm" type="button" title="重试后台保存" aria-label="重试后台保存" @click="backgroundAudio.retry(job.id)"><RefreshCw :size="16" /></button>
      <button v-if="job.phase === 'completed'" class="btn btn-ghost btn-sm" type="button" title="关闭保存提示" aria-label="关闭保存提示" @click="backgroundAudio.dismiss(job.id)"><X :size="16" /></button>
    </div>
  </div>
</template>

<style scoped>
.background-audio { padding: 8px 24px; border-bottom: 1px solid #bcded2; background: #effaf4; color: #215b45; font-size: 13px; }
.background-audio-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; min-height: 28px; overflow-wrap: anywhere; }
.background-audio-row a { color: inherit; max-width: 100%; }
.background-audio-row.failed, .cache-warning { color: #a13838; }
.background-audio-row button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; flex: 0 0 28px; }
@media (max-width: 640px) { .background-audio { padding: 8px 12px; } }
</style>
