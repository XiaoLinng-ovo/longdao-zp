<script setup lang="ts">
import { computed } from 'vue'
import { authSession } from '../session'
import WorkspaceInvitationManager from '../components/WorkspaceInvitationManager.vue'
import PageHeader from '../../../shared/components/PageHeader.vue'
const workspace = computed(() => authSession.workspaces.find(item => item.id === authSession.user?.workspaceId))
</script>
<template>
  <PageHeader title="企业成员" :description="workspace?.name ?? ''" />
  <WorkspaceInvitationManager v-if="workspace" :key="workspace.id" :workspace="workspace" />
</template>
