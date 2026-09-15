<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import AppShell from './app/layout/AppShell.vue'
import { refreshAuthSession } from './modules/auth/session'

const route = useRoute()
const showShell = computed(() => !route.meta.hideShell)

onMounted(refreshAuthSession)
</script>

<template>
  <AppShell v-if="showShell" />
  <router-view v-else />
</template>
