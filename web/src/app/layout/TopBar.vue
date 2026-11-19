<script setup lang="ts">
import { authSession } from '../../modules/auth/session'

defineProps<{ title: string; crumb: string }>()
</script>

<template>
  <header class="topbar">
    <div><h1>{{ title }}</h1><div class="crumb">{{ crumb }}</div></div>
    <div v-if="!authSession.user" class="topbar-user">
      <router-link class="btn btn-ghost" to="/login">登录</router-link>
    </div>
  </header>
</template>
