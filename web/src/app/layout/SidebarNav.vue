<script setup lang="ts">
import { navigationItems } from '../navigation'
const groups = [...new Set(navigationItems.map((item) => item.group))]
</script>
<template><aside class="sidebar"><div class="brand"><span class="brand-mark">龙道</span><span><b>龙道招聘系统</b><small>全流程智能招聘</small></span></div><nav aria-label="主导航"><template v-for="group in groups" :key="group"><div class="nav-group">{{ group }}</div><router-link v-for="item in navigationItems.filter((entry) => entry.group === group)" :key="item.path" :to="item.path" class="nav-item"><span class="nav-icon" aria-hidden="true">{{ item.icon }}</span><span>{{ item.navLabel }}</span></router-link></template></nav><div class="sidebar-footer">V2.0 合并增强版 · 全流程招聘<br /><small>© 2026 龙道数据集团</small></div></aside></template>
