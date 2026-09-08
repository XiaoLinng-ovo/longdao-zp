<script setup lang="ts">
import { navigationItems } from '../navigation'
</script>
<template><aside class="sidebar"><div class="brand"><span class="brand-mark">S</span><span>SmartRecruit</span></div><nav aria-label="主导航"><router-link v-for="item in navigationItems" :key="item.path" :to="item.path" class="nav-item"><span class="nav-icon" aria-hidden="true">{{ item.icon.slice(0, 1).toUpperCase() }}</span><span>{{ item.navLabel }}</span></router-link></nav><div class="sidebar-footer">内部招聘工作台<br /><small>单组织演示环境</small></div></aside></template>
