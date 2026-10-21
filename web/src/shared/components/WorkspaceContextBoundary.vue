<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { WORKSPACE_CONTEXT_EVENT, WORKSPACE_CONTEXT_STORAGE_KEY } from '../api/workspace-context'

const invalidated = ref(false)
function invalidate() { invalidated.value = true }
function onStorage(event: StorageEvent) {
  if (event.key === WORKSPACE_CONTEXT_STORAGE_KEY && event.newValue) invalidate()
}
function refresh() { window.location.reload() }
onMounted(() => {
  window.addEventListener(WORKSPACE_CONTEXT_EVENT, invalidate)
  window.addEventListener('storage', onStorage)
})
onBeforeUnmount(() => {
  window.removeEventListener(WORKSPACE_CONTEXT_EVENT, invalidate)
  window.removeEventListener('storage', onStorage)
})
</script>

<template>
  <main v-if="invalidated" class="workspace-context-notice" role="alert">
    <section>
      <h1>企业或账号已变更</h1>
      <p>其他页面可能切换了企业或账号。为避免把操作提交到错误的企业，当前页面已暂停操作。</p>
      <p>未提交的内容不会自动保存，请刷新后确认顶部企业名称再继续。</p>
      <button class="btn btn-primary" type="button" @click="refresh">刷新并确认当前企业</button>
    </section>
  </main>
  <slot v-else />
</template>

<style scoped>
.workspace-context-notice { display: grid; place-items: center; min-height: 100dvh; padding: 24px; background: #eef7f3; }
.workspace-context-notice section { max-width: 560px; padding: 32px; border: 1px solid #d5e8e0; border-radius: 18px; background: #fff; }
h1 { font-size: 22px; color: #245b50; } p { line-height: 1.8; color: #50665f; }
</style>
