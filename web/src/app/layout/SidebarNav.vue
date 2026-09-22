<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { navigationItems } from '../navigation'
import { administrationModules } from '../../modules/administration/moduleConfig'

const route = useRoute()
const groups = [...new Set(navigationItems.map((item) => item.group))]
const administrationExpanded = ref(route.path === '/administration')
const isAdministrationActive = computed(() => route.path === '/administration')

function toggleAdministration() {
  administrationExpanded.value = !administrationExpanded.value
}

function isAdministrationModuleActive(key: string) {
  const module = Array.isArray(route.query.module) ? route.query.module[0] : route.query.module
  return route.path === '/administration' && (module === key || (!module && key === 'users'))
}
</script>
<template>
  <aside class="sidebar">
    <div class="brand"><span class="brand-mark">龙道</span><span><b>龙道招聘系统</b><small>全流程智能招聘</small></span></div>
    <nav aria-label="主导航">
      <template v-for="group in groups" :key="group">
        <div class="nav-group">{{ group }}</div>
        <template v-for="item in navigationItems.filter((entry) => entry.group === group)" :key="item.path">
          <div v-if="item.path === '/administration'" class="nav-expandable">
            <button
              class="nav-item nav-parent"
              :class="{ 'router-link-active': isAdministrationActive }"
              type="button"
              :aria-expanded="administrationExpanded"
              aria-controls="administration-subnav"
              @click="toggleAdministration"
            >
              <span class="nav-icon" aria-hidden="true">{{ item.icon }}</span>
              <span>{{ item.navLabel }}</span>
              <span class="nav-chevron" aria-hidden="true">{{ administrationExpanded ? '⌄' : '›' }}</span>
            </button>
            <div v-show="administrationExpanded" id="administration-subnav" class="nav-submenu">
              <router-link
                v-for="module in administrationModules"
                :key="module.key"
                :to="{ path: item.path, query: { module: module.key } }"
                class="nav-subitem"
                :class="{ 'is-active': isAdministrationModuleActive(module.key) }"
              >
                <span class="nav-subdot" aria-hidden="true"></span>
                <span>{{ module.label }}</span>
              </router-link>
            </div>
          </div>
          <router-link v-else :to="item.path" class="nav-item">
            <span class="nav-icon" aria-hidden="true">{{ item.icon }}</span>
            <span>{{ item.navLabel }}</span>
          </router-link>
        </template>
      </template>
    </nav>
    <div class="sidebar-footer">V2.0 合并增强版 · 全流程招聘<br /><small>© 2026 龙道数据集团</small></div>
  </aside>
</template>
