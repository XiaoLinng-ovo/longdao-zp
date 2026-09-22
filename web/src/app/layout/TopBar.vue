<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { authSession, logoutCurrentUser } from '../../modules/auth/session'

defineProps<{ title: string; crumb: string }>()

const accountMenuOpen = ref(false)
const accountMenuRef = ref<HTMLElement | null>(null)

const roleLabels: Record<string, string> = {
  admin: '系统管理员',
  hr_admin: 'HR 管理员',
  recruiter: '招聘专员',
  hiring_manager: '招聘经理',
  approver: '审批人',
  interviewer: '面试官',
}

const accountInitial = computed(() => authSession.user?.name?.slice(0, 1) || '用')
const accountRole = computed(() => roleLabels[authSession.user?.role ?? ''] || '平台用户')
const accountDepartment = computed(() => {
  const departmentId = authSession.user?.departmentId?.trim()
  return departmentId || '未分配部门'
})

function toggleAccountMenu() {
  if (!authSession.user) return
  accountMenuOpen.value = !accountMenuOpen.value
}

function closeAccountMenu(event: MouseEvent) {
  if (accountMenuRef.value && !accountMenuRef.value.contains(event.target as Node)) {
    accountMenuOpen.value = false
  }
}

function closeAccountMenuOnEscape(event: KeyboardEvent) {
  if (event.key === 'Escape') accountMenuOpen.value = false
}

async function logout() {
  accountMenuOpen.value = false
  await logoutCurrentUser()
  window.location.href = '/login'
}

onMounted(() => {
  document.addEventListener('click', closeAccountMenu)
  document.addEventListener('keydown', closeAccountMenuOnEscape)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', closeAccountMenu)
  document.removeEventListener('keydown', closeAccountMenuOnEscape)
})
</script>

<template>
  <header class="topbar">
    <div><h1>{{ title }}</h1><div class="crumb">{{ crumb }}</div></div>
    <div class="topbar-user">
      <span class="ai-chip">⚡ 默认 AI 引擎</span>
      <div v-if="authSession.user" ref="accountMenuRef" class="account-menu">
        <button
          class="account-trigger"
          type="button"
          :aria-expanded="accountMenuOpen"
          aria-haspopup="dialog"
          aria-label="打开账号信息"
          @click.stop="toggleAccountMenu"
        >
          <span class="avatar" aria-hidden="true">{{ accountInitial }}</span>
          <span class="auth-name">{{ authSession.user.name }}</span>
          <span class="account-trigger-chevron" aria-hidden="true">⌄</span>
        </button>
        <section v-if="accountMenuOpen" class="account-card" role="dialog" aria-label="账号信息">
          <div class="account-card-head">
            <span class="account-avatar-large" aria-hidden="true">{{ accountInitial }}</span>
            <div class="account-card-title">
              <strong>{{ authSession.user.name }}</strong>
              <span>{{ accountRole }}</span>
            </div>
            <span class="account-online"><i aria-hidden="true"></i>在线</span>
          </div>
          <div class="account-card-divider"></div>
          <div class="account-details">
            <div class="account-detail-row">
              <span class="account-detail-icon" aria-hidden="true">✉</span>
              <span><small>登录邮箱</small><b>{{ authSession.user.email }}</b></span>
            </div>
            <div class="account-detail-row">
              <span class="account-detail-icon" aria-hidden="true">⌂</span>
              <span><small>所属部门</small><b>{{ accountDepartment }}</b></span>
            </div>
            <div class="account-detail-row">
              <span class="account-detail-icon" aria-hidden="true">✦</span>
              <span><small>账号权限</small><b>{{ accountRole }}</b></span>
            </div>
          </div>
          <div class="account-card-footer">
            <span class="account-session-hint">账号已安全登录</span>
            <button class="account-logout" type="button" @click="logout">退出登录</button>
          </div>
        </section>
      </div>
      <span v-else class="auth-user">
        <span class="avatar" aria-label="当前账号">用</span>
        <router-link class="btn btn-ghost btn-sm" to="/login">登录</router-link>
      </span>
    </div>
  </header>
</template>

<style scoped>
.auth-user { display: inline-flex; align-items: center; gap: 8px; }
.auth-name { color: #35546d; font-size: 12px; }
.btn-sm { padding: 4px 8px; font-size: 11.5px; }
.account-menu { position: relative; }
.account-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 3px 7px 3px 4px;
  border: 1px solid transparent;
  border-radius: 13px;
  background: transparent;
  color: inherit;
  transition: background .16s ease, border-color .16s ease, box-shadow .16s ease, transform .16s ease;
}
.account-trigger:hover,
.account-trigger[aria-expanded='true'] {
  border-color: #d7e9f1;
  background: #f4fafc;
  box-shadow: 0 5px 14px rgba(68, 122, 145, .10);
}
.account-trigger:active { transform: translateY(1px) scale(.985); }
.account-trigger-chevron { margin-left: 1px; color: #8aa5b4; font-size: 14px; line-height: 1; }
.avatar {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid #cde8e2;
  border-radius: 50%;
  background: linear-gradient(135deg, #e2f5f0 0%, #dfeeff 100%);
  color: #2c7c91;
  font-weight: 700;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.82), 0 3px 8px rgba(83, 137, 154, .10);
}
.account-card {
  position: absolute;
  z-index: 40;
  top: calc(100% + 12px);
  right: 0;
  width: 316px;
  overflow: hidden;
  border: 1px solid #dcebf0;
  border-radius: 18px;
  background: rgba(255,255,255,.97);
  box-shadow: 0 18px 42px rgba(46, 91, 113, .16), 0 3px 10px rgba(72, 119, 142, .08);
  color: #2a455b;
  animation: account-card-in .18s ease-out;
}
.account-card::before {
  content: '';
  display: block;
  height: 5px;
  background: linear-gradient(90deg, #8bd6c4 0%, #8fc6f0 52%, #c4b8ee 100%);
}
.account-card-head { display: flex; align-items: center; gap: 11px; padding: 17px 17px 14px; background: linear-gradient(135deg, #f4fbfa 0%, #f3f8ff 100%); }
.account-avatar-large { display: grid; place-items: center; flex: 0 0 45px; width: 45px; height: 45px; border: 1px solid #c8e8e3; border-radius: 14px; background: linear-gradient(135deg, #dcf4ec, #dceaff); color: #287b8d; font-size: 18px; font-weight: 750; box-shadow: inset 0 1px 0 rgba(255,255,255,.9); }
.account-card-title { display: grid; min-width: 0; gap: 4px; }
.account-card-title strong { overflow: hidden; color: #24445b; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.account-card-title span { color: #7a96a7; font-size: 11.5px; }
.account-online { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; align-self: flex-start; color: #3a9c7e; font-size: 10.5px; white-space: nowrap; }
.account-online i { width: 6px; height: 6px; border-radius: 50%; background: #52c49c; box-shadow: 0 0 0 3px #dcf5eb; }
.account-card-divider { height: 1px; background: #e8f1f4; }
.account-details { display: grid; gap: 2px; padding: 10px 14px; }
.account-detail-row { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 7px 4px; border-radius: 10px; }
.account-detail-row:hover { background: #f5fafb; }
.account-detail-icon { display: grid; place-items: center; flex: 0 0 27px; width: 27px; height: 27px; border-radius: 8px; background: #edf7f7; color: #4a9a9a; font-size: 13px; }
.account-detail-row > span:last-child { display: grid; min-width: 0; gap: 3px; }
.account-detail-row small { color: #8ba2b0; font-size: 10.5px; }
.account-detail-row b { overflow: hidden; color: #36556b; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.account-card-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px 14px; border-top: 1px solid #edf3f5; background: #fbfdfd; }
.account-session-hint { color: #9aadb8; font-size: 10.5px; }
.account-logout { border: 1px solid #dceaf0; border-radius: 9px; padding: 7px 11px; background: #fff; color: #4a7182; font-size: 11.5px; transition: background .15s ease, border-color .15s ease, color .15s ease, transform .15s ease; }
.account-logout:hover { border-color: #c8e4e5; background: #eef9f7; color: #237c79; }
.account-logout:active { transform: translateY(1px); }
@keyframes account-card-in { from { opacity: 0; transform: translateY(-5px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@media (max-width: 760px) {
  .auth-name, .account-trigger-chevron { display: none; }
  .account-card { position: fixed; top: 74px; right: 14px; width: min(316px, calc(100vw - 28px)); }
}
</style>
