<script setup lang="ts">
import { authSession, logoutCurrentUser } from '../../modules/auth/session'

defineProps<{ title: string; crumb: string }>()

async function logout() {
  await logoutCurrentUser()
  window.location.href = '/login'
}
</script>

<template>
  <header class="topbar">
    <div><h1>{{ title }}</h1><div class="crumb">{{ crumb }}</div></div>
    <div class="topbar-user">
      <span class="ai-chip">⚡ 默认 AI 引擎</span>
      <span v-if="authSession.user" class="auth-user">
        <span class="avatar" aria-label="当前账号">{{ authSession.user.name.slice(0, 1) }}</span>
        <span class="auth-name">{{ authSession.user.name }}</span>
        <button class="btn btn-ghost btn-sm" type="button" @click="logout">退出</button>
      </span>
      <span v-else class="auth-user">
        <span class="avatar" aria-label="当前账号">用</span>
        <router-link class="btn btn-ghost btn-sm" to="/login">登录</router-link>
      </span>
    </div>
  </header>
</template>

<style scoped>
.auth-user { display: inline-flex; align-items: center; gap: 8px; }
.auth-name { color: #334155; font-size: 12px; }
.btn-sm { padding: 4px 8px; font-size: 11.5px; }
</style>
