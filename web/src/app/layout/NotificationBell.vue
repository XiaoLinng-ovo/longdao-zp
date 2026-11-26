<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Bell, CheckCheck, RotateCw, X } from '@lucide/vue'
import { authSession } from '../../modules/auth/session'
import { loadNotifications, readNotifications, type TodoNotification } from '../../modules/dashboard/api/notifications'
import { describeApiFailure } from '../../shared/utils/errorMessage'
const router = useRouter(), route = useRoute()
const dialog = ref<HTMLDialogElement>(), trigger = ref<HTMLButtonElement>()
const items = ref<TodoNotification[]>([]), unreadCount = ref(0), unreadOnly = ref(false)
const error = ref(''), loading = ref(false), nextBefore = ref<string | null>(null)
const identity = computed(() => [authSession.user?.id, authSession.user?.workspaceId].join(':'))
let version = 0, disposed = false, timer: ReturnType<typeof setInterval> | undefined
async function refresh(more = false, force = false) {
  if (!authSession.user?.workspaceId || disposed || (loading.value && !force)) return
  const token = ++version
  loading.value = true
  error.value = ''
  try {
    const inbox = await loadNotifications(unreadOnly.value, more ? nextBefore.value ?? undefined : undefined)
    if (disposed || token !== version) return
    items.value = more ? [...items.value, ...inbox.items.filter(item => !items.value.some(old => old.id === item.id))] : inbox.items
    unreadCount.value = inbox.unreadCount; nextBefore.value = inbox.nextBefore
  } catch (cause) {
    if (token === version && !disposed) error.value = describeApiFailure(cause, '消息同步失败').message
  } finally { if (token === version) loading.value = false }
}
function visibleRefresh() { if (document.visibilityState !== 'hidden') void refresh() }
function open() { dialog.value?.showModal(); void refresh() }
function close() { dialog.value?.close(); trigger.value?.focus() }
async function mark(ids: string[] | 'all') {
  const token = version
  try { await readNotifications(ids); if (token === version) await refresh(false, true) }
  catch (cause) { if (token === version) error.value = describeApiFailure(cause, '标记已读失败').message }
}
async function visit(item: TodoNotification) {
  const key = identity.value
  await mark([item.id])
  if (identity.value !== key) return
  if (item.state === 'active' && item.path?.startsWith('/') && !item.path.startsWith('//')) {
    close(); await router.push(item.path)
  }
}
watch(identity, () => {
  version++; items.value = []; unreadCount.value = 0; nextBefore.value = null; error.value = ''; loading.value = false
  dialog.value?.close(); void refresh(false, true)
})
watch(unreadOnly, () => { items.value = []; nextBefore.value = null; void refresh(false, true) })
watch(() => route.fullPath, visibleRefresh)
onMounted(() => {
  visibleRefresh(); timer = setInterval(visibleRefresh, 30_000)
  window.addEventListener('focus', visibleRefresh); document.addEventListener('visibilitychange', visibleRefresh)
})
onBeforeUnmount(() => {
  disposed = true; version++; clearInterval(timer)
  window.removeEventListener('focus', visibleRefresh); document.removeEventListener('visibilitychange', visibleRefresh)
})
</script>
<template>
  <div v-if="authSession.user?.workspaceId" class="notification-entry">
    <button ref="trigger" type="button" class="notification-trigger" title="待办消息" :aria-label="'待办消息，' + unreadCount + ' 条未读'" aria-haspopup="dialog" @click="open">
      <Bell :size="18" /><span>待办消息</span><b v-if="unreadCount" class="notification-badge">{{ unreadCount > 99 ? '99+' : unreadCount }}</b>
    </button>
    <dialog ref="dialog" class="notification-dialog" aria-labelledby="notifications-title" @click="($event.target === dialog) && close()" @cancel.prevent="close">
      <header><h2 id="notifications-title">待办消息 <small>{{ unreadCount }} 条未读</small></h2><button type="button" title="关闭" aria-label="关闭消息" @click="close"><X :size="20" /></button></header>
      <nav aria-label="消息筛选"><div class="notification-tabs"><button type="button" :aria-pressed="!unreadOnly" @click="unreadOnly = false">全部</button><button type="button" :aria-pressed="unreadOnly" @click="unreadOnly = true">未读</button></div><div><button type="button" title="刷新" aria-label="刷新消息" :disabled="loading" @click="refresh()"><RotateCw :size="16" /></button><button type="button" title="全部已读" aria-label="全部标记已读" :disabled="!unreadCount || loading" @click="mark('all')"><CheckCheck :size="18" /></button></div></nav>
      <p v-if="error" class="notification-error" role="alert">{{ error }} <button type="button" @click="refresh()">重试</button></p>
      <div class="notification-list" :aria-busy="loading">
        <p v-if="!items.length" class="notification-empty">{{ loading ? '正在同步消息...' : unreadOnly ? '暂无未读消息' : '暂无消息' }}</p>
        <article v-for="item in items" :key="item.id" :class="{ unread: !item.readAt }">
          <button class="notification-message" type="button" @click="visit(item)"><strong>{{ item.title }}</strong><span>{{ item.description }}</span><small>{{ new Date(item.createdAt).toLocaleString('zh-CN') }} · {{ item.state === 'active' ? '待处理' : item.state === 'cancelled' ? '已取消或移交' : '已结束' }}</small></button>
          <button v-if="!item.readAt" type="button" title="标记已读" aria-label="标记该消息已读" @click="mark([item.id])"><CheckCheck :size="16" /></button>
        </article>
        <button v-if="nextBefore" class="notification-more" type="button" :disabled="loading" @click="refresh(true)">加载更多</button>
      </div>
    </dialog>
  </div>
</template>
<style scoped>
.notification-entry { width: 100%; }
.notification-trigger { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 36px; padding: 7px 12px; border: 0; border-top: 1px solid #e1e8ec; background: transparent; color: #486271; cursor: pointer; font-size: 12px; }
.notification-badge { margin-left: auto; min-width: 20px; padding: 2px 4px; border-radius: 8px; background: #c64040; color: white; font-size: 10px; }
.notification-dialog { width: min(520px, calc(100vw - 28px)); max-height: min(680px, calc(100dvh - 40px)); padding: 0; border: 1px solid #dce4e8; border-radius: 8px; color: #243e49; box-shadow: 0 16px 56px #142a3330; }
.notification-dialog::backdrop { background: #17252e50; }
header, nav { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid #e4ebee; }
h2 { margin: 0; font-size: 16px; } h2 small { color: #667b85; font-size: 12px; font-weight: 400; }
button { cursor: pointer; } header button, nav button, article > button { display: inline-flex; align-items: center; justify-content: center; min-width: 32px; min-height: 32px; border: 0; border-radius: 4px; background: transparent; color: inherit; } button:disabled { opacity: .5; cursor: default; }
nav { padding-block: 8px; } nav > div { display: flex; gap: 4px; } .notification-tabs button { padding: 6px 14px; } .notification-tabs button[aria-pressed="true"] { color: #147b70; background: #e6f4ef; }
.notification-list { overflow-y: auto; max-height: min(490px, calc(100dvh - 200px)); }
article { display: flex; align-items: flex-start; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #edf1f3; } article.unread { background: #f0f8fc; border-left: 3px solid #269383; }
article .notification-message { display: grid; justify-content: start; text-align: left; flex: 1; min-width: 0; gap: 6px; padding: 0; }
.notification-message strong { font-size: 13px; } .notification-message span { font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; } .notification-message small { color: #70838d; font-size: 11px; }
.notification-empty { padding: 30px 18px; text-align: center; color: #70838d; } .notification-error { padding: 10px 18px; color: #b13e3e; font-size: 12px; } .notification-more { width: 100%; padding: 12px; border: 0; background: #f5f8fa; color: #226b81; }
button:focus-visible { outline: 2px solid #269383; outline-offset: 2px; }
</style>
