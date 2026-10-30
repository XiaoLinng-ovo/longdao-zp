<script setup lang="ts">
import { isWorkspaceAvailable, workspaceServiceLabel } from '../../modules/auth/utils/workspace-service'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { listWorkspaces, type WorkspaceSummary } from '../../modules/auth/api'
import { authSession, switchWorkspace } from '../../modules/auth/session'
import { describeApiFailure } from '../../shared/utils/errorMessage'

const open = ref(false)
const loading = ref(false)
const switchingId = ref('')
const error = ref('')
const root = ref<HTMLElement | null>(null)

const activeWorkspaces = computed(() => {
  const workspaces = Array.isArray(authSession.workspaces) ? authSession.workspaces : []
  return workspaces.filter((workspace) => workspace.status === 'active')
})
const currentWorkspace = computed(() => {
  const selected = activeWorkspaces.value.find((workspace) => workspace.id === authSession.user?.workspaceId)
  if (selected) return selected
  if (!authSession.user?.workspaceId) return undefined
  return {
    id: authSession.user.workspaceId,
    name: authSession.user.workspaceName || '当前企业',
    kind: authSession.user.workspaceKind || 'test',
    status: 'active',
    role: 'member',
    createdAt: '',
  } satisfies WorkspaceSummary
})

function close() { open.value = false }

async function refreshList() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    authSession.workspaces = await listWorkspaces()
  } catch (cause) {
    error.value = describeApiFailure(cause, '无法读取企业列表').message
  } finally {
    loading.value = false
  }
}

async function toggle() {
  if (switchingId.value) return
  open.value = !open.value
  if (open.value) await refreshList()
}

async function select(workspace: WorkspaceSummary) {
  if (workspace.id === authSession.user?.workspaceId || !isWorkspaceAvailable(workspace) || switchingId.value) return
  switchingId.value = workspace.id
  error.value = ''
  try {
    await switchWorkspace(workspace.id)
    close()
    // Clear route-level data and rerun authorization guards for the new tenant.
    window.location.assign('/')
  } catch (cause) {
    error.value = describeApiFailure(cause, '切换企业失败，请稍后重试').message
  } finally {
    switchingId.value = ''
  }
}

function closeOnOutside(event: MouseEvent) {
  if (root.value && !root.value.contains(event.target as Node)) close()
}
function closeOnEscape(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    close()
    root.value?.querySelector<HTMLButtonElement>('.workspace-switcher-trigger')?.focus()
  }
}

onMounted(() => {
  document.addEventListener('click', closeOnOutside)
  document.addEventListener('keydown', closeOnEscape)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', closeOnOutside)
  document.removeEventListener('keydown', closeOnEscape)
})
</script>

<template>
  <div v-if="authSession.user" ref="root" class="workspace-switcher">
    <button class="workspace-switcher-trigger" type="button" :aria-expanded="open" aria-haspopup="dialog" @click.stop="toggle">
      <span class="workspace-switcher-icon" aria-hidden="true">⌂</span>
      <span class="workspace-switcher-label">
        <small>当前企业</small>
        <strong>{{ currentWorkspace?.name || '选择企业' }}</strong>
      </span>
      <span v-if="currentWorkspace" class="workspace-switcher-kind">{{ currentWorkspace.kind === 'test' ? '测试' : '正式' }}</span>
      <span class="workspace-switcher-chevron" aria-hidden="true">⌄</span>
    </button>

    <div v-if="open" class="workspace-switcher-panel" role="dialog" aria-label="切换企业工作空间">
      <div class="workspace-switcher-heading">
        <div><strong>企业工作空间</strong><span>快速切换后将重新加载当前页面</span></div>
        <button class="workspace-switcher-close" type="button" aria-label="关闭企业切换" @click="close">×</button>
      </div>
      <div v-if="loading" class="workspace-switcher-state">正在读取企业列表…</div>
      <div v-else-if="!activeWorkspaces.length" class="workspace-switcher-state">暂无可用企业，请先加入或创建工作空间。</div>
      <div v-else class="workspace-switcher-list">
        <button
          v-for="workspace in activeWorkspaces"
          :key="workspace.id"
          class="workspace-switcher-item"
          :class="{ 'is-current': workspace.id === authSession.user?.workspaceId }"
          type="button"
          :disabled="!isWorkspaceAvailable(workspace) || workspace.id === authSession.user?.workspaceId || Boolean(switchingId)"
          @click="select(workspace)"
        >
          <span class="workspace-switcher-item-mark">{{ workspace.kind === 'test' ? '测' : '正' }}</span>
          <span class="workspace-switcher-item-copy"><b>{{ workspace.name }}</b><small>{{ workspace.role === 'owner' ? '所有者' : workspace.role === 'admin' ? '企业管理员' : '成员' }}</small></span>
          <span class="workspace-switcher-item-state">{{ !isWorkspaceAvailable(workspace) ? workspaceServiceLabel(workspace) : workspace.id === authSession.user?.workspaceId ? '当前' : switchingId === workspace.id ? '切换中…' : '切换' }}</span>
        </button>
      </div>
      <p v-if="error" class="workspace-switcher-error" role="alert">{{ error }}</p>
      <router-link class="workspace-switcher-manage" to="/workspaces" @click="close">管理企业与成员 <span aria-hidden="true">→</span></router-link>
    </div>
  </div>
</template>

<style scoped>
.workspace-switcher { position: relative; min-width: 0; }
.workspace-switcher-trigger { display: flex; align-items: center; gap: 8px; min-width: 184px; max-width: 255px; padding: 6px 9px; border: 1px solid #dcebef; border-radius: 12px; background: linear-gradient(145deg, #f8fdfd, #f3f8ff); color: #315870; cursor: pointer; text-align: left; }
.workspace-switcher-trigger:hover { border-color: #b9dfe0; box-shadow: 0 5px 13px rgba(69, 132, 151, .1); }
.workspace-switcher-icon { display: grid; place-items: center; width: 27px; height: 27px; flex: 0 0 27px; border-radius: 9px; background: linear-gradient(145deg, #d9f4ed, #dceafb); color: #398f96; font-size: 15px; }
.workspace-switcher-label { display: grid; min-width: 0; flex: 1; gap: 2px; }
.workspace-switcher-label small { color: #91a6b2; font-size: 9px; }
.workspace-switcher-label strong { overflow: hidden; color: #315870; font-size: 11px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.workspace-switcher-kind { flex: 0 0 auto; border-radius: 99px; padding: 3px 6px; background: #e6f6f1; color: #4a9885; font-size: 9px; }
.workspace-switcher-chevron { flex: 0 0 auto; color: #7f9aa8; font-size: 13px; }
.workspace-switcher-panel { position: absolute; z-index: 40; top: calc(100% + 9px); right: 0; width: min(335px, calc(100vw - 28px)); overflow: hidden; border: 1px solid #dcebef; border-radius: 15px; background: #fff; box-shadow: 0 18px 40px rgba(53, 96, 123, .17); }
.workspace-switcher-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 14px 15px 12px; border-bottom: 1px solid #edf3f5; background: linear-gradient(145deg, #f2fbfa, #f4f8ff); }
.workspace-switcher-heading div { display: grid; gap: 4px; }
.workspace-switcher-heading strong { color: #315870; font-size: 12px; }
.workspace-switcher-heading span { color: #8aa1ad; font-size: 10px; }
.workspace-switcher-close { border: 0; background: transparent; color: #8aa1ad; font-size: 20px; line-height: 1; cursor: pointer; }
.workspace-switcher-list { display: grid; gap: 7px; max-height: 270px; overflow-y: auto; padding: 11px; }
.workspace-switcher-item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px; border: 1px solid #e1edf1; border-radius: 11px; background: #fff; color: #36556b; text-align: left; cursor: pointer; }
.workspace-switcher-item:not(:disabled):hover { border-color: #acd9dc; background: #f4fbfb; }
.workspace-switcher-item:disabled { cursor: default; }
.workspace-switcher-item.is-current { border-color: #c5e5d9; background: #f0faf6; }
.workspace-switcher-item-mark { display: grid; place-items: center; width: 30px; height: 30px; flex: 0 0 30px; border-radius: 9px; background: linear-gradient(145deg, #dff3ec, #deecfc); color: #3b8c97; font-size: 12px; font-weight: 700; }
.workspace-switcher-item-copy { display: grid; min-width: 0; flex: 1; gap: 3px; }
.workspace-switcher-item-copy b { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.workspace-switcher-item-copy small { color: #8aa1ad; font-size: 9px; }
.workspace-switcher-item-state { flex: 0 0 auto; color: #4a9885; font-size: 10px; }
.workspace-switcher-state { padding: 24px 14px; color: #8aa1ad; font-size: 11px; line-height: 1.7; text-align: center; }
.workspace-switcher-error { margin: 0 11px 9px; padding: 8px; border-radius: 8px; background: #fff1f2; color: #b65a69; font-size: 10px; line-height: 1.6; }
.workspace-switcher-manage { display: flex; justify-content: space-between; align-items: center; padding: 11px 14px; border-top: 1px solid #edf3f5; color: #398f96; font-size: 11px; text-decoration: none; }
.workspace-switcher-manage:hover { background: #f5fbfb; }
.workspace-switcher-trigger:focus-visible, .workspace-switcher-close:focus-visible, .workspace-switcher-item:focus-visible, .workspace-switcher-manage:focus-visible { outline: 2px solid #63afc8; outline-offset: 2px; }
@media (max-width: 900px) { .workspace-switcher-trigger { min-width: 150px; } .workspace-switcher-label small { display: none; } }
@media (max-width: 760px) { .workspace-switcher-trigger { min-width: 110px; max-width: 150px; padding: 7px; } .workspace-switcher-icon, .workspace-switcher-kind { display: none; } .workspace-switcher-panel { position: fixed; top: 76px; right: 14px; } }
</style>
