<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import SidebarNav from './SidebarNav.vue'
import TopBar from './TopBar.vue'
const route = useRoute()
const title = computed(() => String(route.meta.title ?? '招聘工作台'))
const crumb = computed(() => String(route.meta.crumb ?? `首页 / ${title.value}`))
watch(title, (value) => { document.title = `${value} | 招聘管理` }, { immediate: true })
</script>
<template><div class="app-shell"><SidebarNav /><div class="app-main"><TopBar :title="title" :crumb="crumb" /><main class="page-content"><router-view /></main></div></div></template>
