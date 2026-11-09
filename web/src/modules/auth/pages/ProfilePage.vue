<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, Building2, BriefcaseBusiness, Check, Mail, Save, ShieldCheck, UserRound } from '@lucide/vue'
import { authSession, saveCurrentUserProfile } from '../session'
import { businessRoleLabels, membershipLabels } from '../utils/invitations'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { isPlatformAdminRole } from '../platform-roles'

const router = useRouter()
const name = ref(authSession.user?.name ?? '')
const phone = ref(authSession.user?.phone ?? '')
const saving = ref(false)
const error = ref('')
const notice = ref('')

const currentWorkspace = computed(() => {
  const user = authSession.user
  if (!user) return undefined
  return authSession.workspaces?.find((workspace) => workspace.id === user.workspaceId)
})
const currentWorkspaceName = computed(() => currentWorkspace.value?.name || authSession.user?.workspaceName || '尚未选择企业空间')
const currentWorkspaceKind = computed(() => currentWorkspace.value?.kind || authSession.user?.workspaceKind)
const currentWorkspaceKindLabel = computed(() => currentWorkspaceKind.value === 'production' ? '正式' : currentWorkspaceKind.value === 'test' ? '测试' : '待选择')
const currentWorkspaceRole = computed(() => currentWorkspace.value?.role ? membershipLabels[currentWorkspace.value.role] : '')
const department = computed(() => authSession.user?.departmentId?.trim() || '未分配部门')
const businessRole = computed(() => businessRoleLabels[authSession.user?.role ?? ''] || '平台用户')
const platformRole = computed(() => isPlatformAdminRole(authSession.user?.platformRole) ? '平台管理员' : authSession.user?.platformRole === 'viewer' ? '平台只读运营' : '未授予平台运营身份')
const hasChanges = computed(() => name.value !== (authSession.user?.name ?? '') || phone.value !== (authSession.user?.phone ?? ''))
const canSave = computed(() => hasChanges.value && Boolean(name.value.trim()) && Array.from(name.value.trim()).length <= 50 && Array.from(phone.value.trim()).length <= 30)

watch(
  () => authSession.user,
  (user) => {
    name.value = user?.name ?? ''
    phone.value = user?.phone ?? ''
  },
)

function goBack() {
  void router.push(authSession.user?.workspaceId ? '/' : '/workspaces')
}

async function save() {
  if (!canSave.value || saving.value) return
  const normalizedName = name.value.trim()
  if (!normalizedName) {
    error.value = '姓名不能为空'
    return
  }
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    await saveCurrentUserProfile({ name: normalizedName, phone: phone.value.trim() })
    name.value = normalizedName
    notice.value = '个人信息已更新'
  } catch (cause) {
    error.value = describeApiFailure(cause, '个人信息保存失败').message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <main class="profile-page">
    <header class="profile-page-head">
      <button class="profile-back" type="button" @click="goBack">
        <ArrowLeft :size="16" aria-hidden="true" />
        返回
      </button>
      <div>
        <span class="profile-kicker">ACCOUNT CENTER</span>
        <h2>用户信息</h2>
        <p>管理你的基础联系方式。企业和平台身份由管理员维护，不能在这里修改。</p>
      </div>
    </header>

    <section class="profile-identity-band" aria-label="当前账号">
      <span class="profile-avatar" aria-hidden="true">{{ authSession.user?.name?.slice(0, 1) || '用' }}</span>
      <div class="profile-identity-copy">
        <strong>{{ authSession.user?.name }}</strong>
        <span>{{ authSession.user?.email }}</span>
      </div>
      <div class="profile-workspace-chip">
        <Building2 :size="16" aria-hidden="true" />
        <span><small>当前企业空间</small><b>{{ currentWorkspaceName }}</b></span>
        <i :class="{ 'is-production': currentWorkspaceKind === 'production' }">{{ currentWorkspaceKindLabel }}</i>
      </div>
    </section>

    <div class="profile-layout">
      <section class="profile-panel profile-editor" aria-labelledby="profile-editor-title">
        <div class="profile-panel-head">
          <span class="profile-panel-icon"><UserRound :size="18" aria-hidden="true" /></span>
          <div><h3 id="profile-editor-title">基础信息</h3><p>姓名会显示在工作台和账号菜单中。</p></div>
        </div>
        <form class="profile-form" @submit.prevent="save">
          <label class="profile-field">
            <span>姓名 <i>可编辑</i></span>
            <input v-model="name" type="text" maxlength="50" autocomplete="name" placeholder="请输入姓名" />
          </label>
          <label class="profile-field">
            <span>手机号 <i>可编辑</i></span>
            <input v-model="phone" type="tel" maxlength="30" autocomplete="tel" placeholder="请输入手机号" />
          </label>
          <p v-if="error" class="profile-feedback is-error" role="alert">{{ error }}</p>
          <p v-if="notice" class="profile-feedback is-success" role="status"><Check :size="15" aria-hidden="true" />{{ notice }}</p>
          <div class="profile-actions">
            <button class="profile-save" type="submit" :disabled="!canSave || saving">
              <Save :size="16" aria-hidden="true" />
              {{ saving ? '保存中...' : '保存修改' }}
            </button>
          </div>
        </form>
      </section>

      <aside class="profile-panel profile-overview" aria-labelledby="profile-overview-title">
        <div class="profile-panel-head">
          <span class="profile-panel-icon is-blue"><ShieldCheck :size="18" aria-hidden="true" /></span>
          <div><h3 id="profile-overview-title">账号与身份</h3><p>以下信息由系统和企业管理员维护。</p></div>
        </div>
        <dl class="profile-facts">
          <div>
            <dt><ShieldCheck :size="15" aria-hidden="true" />用户编码</dt>
            <dd><code class="profile-user-no">{{ authSession.user?.userNo || '生成中' }}</code></dd>
          </div>
          <div>
            <dt><Mail :size="15" aria-hidden="true" />登录邮箱</dt>
            <dd>{{ authSession.user?.email || '未设置' }}</dd>
          </div>
          <div>
            <dt><Building2 :size="15" aria-hidden="true" />当前企业空间</dt>
            <dd>{{ currentWorkspaceName }}<small v-if="currentWorkspaceRole">{{ currentWorkspaceRole }}</small></dd>
          </div>
          <div>
            <dt><BriefcaseBusiness :size="15" aria-hidden="true" />所属部门</dt>
            <dd>{{ department }}</dd>
          </div>
          <div>
            <dt><BriefcaseBusiness :size="15" aria-hidden="true" />账号类型</dt>
            <dd>{{ businessRole }}</dd>
          </div>
          <div>
            <dt><ShieldCheck :size="15" aria-hidden="true" />平台运营身份</dt>
            <dd>{{ platformRole }}</dd>
          </div>
        </dl>
      </aside>
    </div>
  </main>
</template>

<style scoped>
.profile-page { display: grid; gap: 18px; max-width: 1100px; margin: 0 auto; color: #27475b; }
.profile-page-head { display: flex; align-items: flex-start; gap: 16px; }
.profile-back { display: inline-flex; align-items: center; gap: 5px; min-height: 34px; margin-top: 20px; border: 1px solid #d9e8ee; border-radius: 8px; padding: 0 10px; background: #fff; color: #577486; font-size: 12px; cursor: pointer; }
.profile-back:hover { border-color: #b9d8df; background: #f7fbfc; color: #2f7d87; }
.profile-kicker { color: #55a5a5; font-size: 10px; font-weight: 800; letter-spacing: .08em; }
.profile-page-head h2 { margin: 5px 0 4px; color: #19374c; font-size: 24px; }
.profile-page-head p { margin: 0; color: #8197a5; font-size: 12px; line-height: 1.65; }
.profile-identity-band { display: flex; align-items: center; gap: 13px; min-width: 0; padding: 16px 18px; border: 1px solid #dfecef; border-radius: 10px; background: linear-gradient(105deg, #f4fbfa, #f8fbff 64%, #f5f8ff); }
.profile-avatar { display: grid; place-items: center; flex: 0 0 48px; width: 48px; height: 48px; border: 1px solid #c7e6df; border-radius: 14px; background: #e5f6f1; color: #328584; font-size: 18px; font-weight: 800; }
.profile-identity-copy { display: grid; min-width: 0; gap: 4px; }
.profile-identity-copy strong { color: #23475d; font-size: 15px; }
.profile-identity-copy span { overflow: hidden; color: #8199a8; font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }
.profile-workspace-chip { display: flex; align-items: center; gap: 9px; min-width: 0; margin-left: auto; padding-left: 18px; border-left: 1px solid #dce9ef; color: #5c7b8c; }
.profile-workspace-chip > span { display: grid; min-width: 0; gap: 3px; }
.profile-workspace-chip small { color: #91a5b1; font-size: 10px; }
.profile-workspace-chip b { max-width: 250px; overflow: hidden; color: #31556a; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.profile-workspace-chip i { flex: 0 0 auto; border-radius: 5px; padding: 3px 7px; background: #e8f6fb; color: #3b8aa6; font-size: 10px; font-style: normal; font-weight: 700; }
.profile-workspace-chip i.is-production { background: #e8f7ef; color: #2f956d; }
.profile-layout { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(320px, .95fr); align-items: start; gap: 18px; }
.profile-panel { min-width: 0; border: 1px solid #dfeaf0; border-radius: 10px; background: #fff; box-shadow: 0 7px 20px rgba(64, 99, 122, .055); }
.profile-panel-head { display: flex; align-items: flex-start; gap: 11px; padding: 18px 19px 15px; border-bottom: 1px solid #edf2f5; }
.profile-panel-icon { display: grid; place-items: center; flex: 0 0 34px; width: 34px; height: 34px; border-radius: 9px; background: #eaf7f3; color: #3a9b86; }
.profile-panel-icon.is-blue { background: #eef5fd; color: #568fd5; }
.profile-panel-head h3 { margin: 1px 0 4px; color: #284a5f; font-size: 14px; }
.profile-panel-head p { margin: 0; color: #91a3ae; font-size: 10.5px; line-height: 1.5; }
.profile-form { display: grid; gap: 15px; padding: 19px; }
.profile-field { display: grid; gap: 7px; color: #58778a; font-size: 11.5px; }
.profile-field > span { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.profile-field i { color: #a1b1ba; font-size: 9.5px; font-style: normal; }
.profile-field input { width: 100%; min-height: 42px; box-sizing: border-box; border: 1px solid #d7e5eb; border-radius: 8px; padding: 0 12px; outline: none; background: #fbfdfe; color: #2e5064; font: inherit; transition: border-color .16s ease, box-shadow .16s ease, background .16s ease; }
.profile-field input:focus { border-color: #70bdc2; background: #fff; box-shadow: 0 0 0 3px rgba(77, 170, 173, .12); }
.profile-feedback { display: flex; align-items: center; gap: 6px; margin: 0; border-radius: 7px; padding: 9px 10px; font-size: 11.5px; }
.profile-feedback.is-error { background: #fff3f3; color: #b05f69; }
.profile-feedback.is-success { background: #eff9f4; color: #34856c; }
.profile-actions { display: flex; justify-content: flex-end; padding-top: 2px; }
.profile-save { display: inline-flex; align-items: center; gap: 6px; min-height: 38px; border: 0; border-radius: 8px; padding: 0 14px; background: #3985d8; color: #fff; font-size: 12px; font-weight: 700; cursor: pointer; box-shadow: 0 5px 12px rgba(57, 133, 216, .16); }
.profile-save:hover:not(:disabled) { background: #2b73c2; }
.profile-save:disabled { cursor: not-allowed; opacity: .48; box-shadow: none; }
.profile-facts { display: grid; margin: 0; padding: 5px 19px 12px; }
.profile-facts > div { display: grid; gap: 5px; padding: 12px 1px; border-bottom: 1px solid #eff3f5; }
.profile-facts > div:last-child { border-bottom: 0; }
.profile-facts dt { display: flex; align-items: center; gap: 7px; color: #8ba0ad; font-size: 10.5px; }
.profile-facts dd { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; overflow-wrap: anywhere; color: #35586d; font-size: 12px; font-weight: 600; }
.profile-user-no { border-radius: 5px; padding: 2px 6px; background: #eef5fd; color: #3d6f9e; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; letter-spacing: .02em; }
.profile-facts dd small { flex: 0 0 auto; border-radius: 5px; padding: 2px 6px; background: #f0f6f8; color: #6f8b9b; font-size: 9.5px; font-weight: 500; }
@media (max-width: 900px) { .profile-layout { grid-template-columns: 1fr; } }
@media (max-width: 620px) {
  .profile-page-head { gap: 10px; }
  .profile-back { flex: 0 0 auto; margin-top: 17px; padding: 0 8px; }
  .profile-page-head h2 { font-size: 21px; }
  .profile-identity-band { align-items: flex-start; flex-wrap: wrap; }
  .profile-workspace-chip { width: 100%; margin-left: 61px; padding: 12px 0 0; border-top: 1px solid #dce9ef; border-left: 0; }
  .profile-workspace-chip b { max-width: calc(100vw - 155px); }
}
</style>
