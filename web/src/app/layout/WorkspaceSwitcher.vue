<script setup lang="ts">
import { computed } from 'vue'
import { Building2 } from '@lucide/vue'
import { authSession } from '../../modules/auth/session'
import { membershipLabels } from '../../modules/auth/utils/invitations'
import { workspaceServiceBadge } from '../../modules/auth/utils/workspace-service'
const emit = defineEmits<{ manage: [] }>()
const workspace = computed(() => authSession.workspaces?.[0])
const name = computed(() => workspace.value?.name ?? authSession.user?.workspaceName ?? '尚未加入企业')
</script>

<template>
  <div class="current-enterprise">
    <Building2 :size="20" aria-hidden="true" />
    <div class="enterprise-copy">
      <small>当前企业</small>
      <strong>{{ name }}</strong>
      <span v-if="workspace">{{ membershipLabels[workspace.role] }} · {{ workspace.membershipActive === false ? '成员已停用' : workspaceServiceBadge(workspace) }}</span>
    </div>
    <router-link to="/workspaces" @click="emit('manage')">{{ workspace ? '企业信息' : '创建 / 加入' }}</router-link>
  </div>
</template>

<style scoped>
.current-enterprise { display:flex; align-items:center; gap:8px; min-width:0; padding:8px 0; color:#317a75; }
.enterprise-copy { display:grid; gap:3px; min-width:0; flex:1; }
.enterprise-copy small,.enterprise-copy span { color:#697d86; font-size:11px; }
.enterprise-copy strong { font-size:13px; overflow-wrap:anywhere; }
.current-enterprise a { flex-shrink:0; color:#317a75; font-size:11px; text-decoration:none; }
.current-enterprise a:focus-visible { outline:2px solid #317a75; outline-offset:3px; }
</style>
