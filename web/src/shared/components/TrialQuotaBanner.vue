<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { loadTrialUsage, type TrialQuotaUsage } from '../api/trial-usage'

const usage = ref<TrialQuotaUsage | null>(null)
const error = ref('')

async function refresh() {
  error.value = ''
  try {
    usage.value = await loadTrialUsage()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '试用额度读取失败'
  }
}

function onQuotaChanged() {
  void refresh()
}

onMounted(() => {
  void refresh()
  window.addEventListener('trial-quota-changed', onQuotaChanged)
})
onBeforeUnmount(() => window.removeEventListener('trial-quota-changed', onQuotaChanged))
</script>

<template>
  <section v-if="usage?.enforced" class="trial-quota" aria-label="试用功能额度">
    <div class="quota-copy">
      <strong>14 天试用额度</strong>
      <span>试用期内最多上传 3 份简历、实际进行 3 场面试；创建或改期面试记录不消耗额度。</span>
    </div>
    <div class="quota-items">
      <span :class="{ reached: usage.resumeUploads.reached }">简历 {{ usage.resumeUploads.used }} / {{ usage.resumeUploads.limit }}</span>
      <span :class="{ reached: usage.interviews.reached }">真实面试 {{ usage.interviews.used }} / {{ usage.interviews.limit }}</span>
    </div>
  </section>
  <p v-else-if="error" class="trial-quota-error">{{ error }}</p>
</template>

<style scoped>
.trial-quota { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; padding: 11px 14px; border: 1px solid #d7e6df; border-radius: 7px; background: #f5faf7; color: #496159; }
.quota-copy { display: grid; gap: 3px; }
.quota-copy strong { color: #27483c; font-size: 11px; }
.quota-copy span { font-size: 9.5px; line-height: 1.5; }
.quota-items { display: flex; flex: 0 0 auto; gap: 7px; }
.quota-items span { padding: 5px 8px; border-radius: 999px; background: #e6f2ec; color: #2c7259; font-size: 9.5px; font-weight: 700; white-space: nowrap; }
.quota-items span.reached { background: #faecee; color: #a4474f; }
.trial-quota-error { margin: 0 0 12px; color: #a4474f; font-size: 10px; }
@media (max-width: 620px) {
  .trial-quota { align-items: flex-start; flex-direction: column; }
}
</style>
