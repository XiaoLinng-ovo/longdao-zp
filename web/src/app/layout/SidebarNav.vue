<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import { useRoute } from 'vue-router'
import {
  Activity, Archive, Blocks, BriefcaseBusiness, Building2, ChartColumn,
  ChevronRight, ClipboardCheck, ClipboardList, CreditCard, FileCheck2,
  FileClock, FileSearch, History, LayoutDashboard, MessageSquare,
  Network, Plug, Settings2, ShieldCheck, SlidersHorizontal, Sparkles,
  UserPlus, Users, Wallet,
} from '@lucide/vue'
import { getNavigationItemsForRole } from '../navigation'
import { authSession } from '../../modules/auth/session'
import { platformAdministrationModules } from '../../modules/administration/moduleConfig'

const route = useRoute()
const visibleNavigationItems = computed(() => {
  const workspaceRole = authSession.workspaces.find((workspace) => workspace.id === authSession.user?.workspaceId)?.role
  return getNavigationItemsForRole(authSession.user?.role, workspaceRole, authSession.user?.platformRole)
})
const groups = computed(() => [...new Set(visibleNavigationItems.value.map((item) => item.group))])
const administrationExpanded = ref(route.path === '/administration')
const isAdministrationActive = computed(() => route.path === '/administration')

const navigationIcons: Record<string, Component> = {
  '/': LayoutDashboard,
  '/requisitions': ClipboardList,
  '/jobs': BriefcaseBusiness,
  '/candidates': FileSearch,
  '/interviews': MessageSquare,
  '/offers': FileCheck2,
  '/onboarding': Archive,
  '/reports': ChartColumn,
  '/workspaces': Building2,
  '/enterprise/ai': Sparkles,
  '/enterprise/ai-usage': Activity,
  '/enterprise/billing-sandbox': CreditCard,
  '/enterprise/payments': Wallet,
  '/enterprise/approval-settings': ClipboardCheck,
  '/platform/payments': CreditCard,
  '/platform/customers': Building2,
  '/administration': Settings2,
}

const administrationIcons: Record<string, Component> = {
  users: Users,
  'account-creation': UserPlus,
  departments: Network,
  settings: SlidersHorizontal,
  dingtalk: Plug,
  channels: Blocks,
  'audit-logs': History,
  health: Activity,
  security: ShieldCheck,
}

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
      <div v-for="group in groups" :key="group" class="nav-section">
        <div class="nav-group">{{ group }}</div>
        <template v-for="item in visibleNavigationItems.filter((entry) => entry.group === group)" :key="item.path">
          <div v-if="item.path === '/administration'" class="nav-expandable">
            <button
              class="nav-item nav-parent"
              :class="{ 'router-link-active': isAdministrationActive }"
              type="button"
              :aria-expanded="administrationExpanded"
              aria-controls="administration-subnav"
              @click="toggleAdministration"
            >
              <component :is="navigationIcons[item.path] ?? FileClock" class="nav-icon" :size="18" :stroke-width="1.7" aria-hidden="true" />
              <span class="nav-label">{{ item.navLabel }}</span>
              <ChevronRight class="nav-chevron" :class="{ 'is-expanded': administrationExpanded }" :size="15" :stroke-width="1.7" aria-hidden="true" />
            </button>
            <div v-show="administrationExpanded" id="administration-subnav" class="nav-submenu">
              <router-link
                v-for="module in platformAdministrationModules"
                :key="module.key"
                :to="{ path: item.path, query: { module: module.key } }"
                class="nav-subitem"
                :class="{ 'is-active': isAdministrationModuleActive(module.key) }"
              >
                <span class="nav-subitem-content">
                  <component :is="administrationIcons[module.key] ?? Settings2" class="nav-icon nav-subicon" :size="16" :stroke-width="1.7" aria-hidden="true" />
                  <span>{{ module.label }}</span>
                </span>
              </router-link>
            </div>
          </div>
          <router-link v-else :to="item.path" class="nav-item">
            <component :is="navigationIcons[item.path] ?? FileClock" class="nav-icon" :size="18" :stroke-width="1.7" aria-hidden="true" />
            <span class="nav-label">{{ item.navLabel }}</span>
          </router-link>
        </template>
      </div>
    </nav>
    <div class="sidebar-footer">V2.0 合并增强版 · 全流程招聘<br /><small>© 2026 龙道数据集团</small></div>
  </aside>
</template>
