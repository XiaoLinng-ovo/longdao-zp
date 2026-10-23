<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { authSession } from '../../auth/session'
import { createAdminUser, listAccountOrganizations, type AdminAccountOrganization, type AdminDepartment, type AdminRole, type AdminUser, type AdminUserCreateResult } from '../api'

const props = defineProps<{ roles: AdminRole[]; departments: AdminDepartment[] }>()
const emit = defineEmits<{ created: [user: AdminUser] }>()
const allowedRoles = new Set(['recruiter', 'hiring_manager', 'approver', 'interviewer', 'hr_admin', 'admin'])
const businessRoles = computed(() => props.roles.filter(role => allowedRoles.has(role.code)))
const activeDepartments = computed(() => props.departments.filter(department => department.isActive))
const organizations = ref<AdminAccountOrganization[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const copied = ref(false)
const copyError = ref('')
const result = ref<AdminUserCreateResult | null>(null)
const passwordMode = ref<'automatic' | 'custom'>('automatic')
const showPassword = ref(false)
const draft = reactive({ email: '', displayName: '', organizationId: '', departmentCode: '', role: 'recruiter', password: '' })
let disposed = false

async function loadOrganizations() {
  loading.value = true
  error.value = ''
  try {
    const items = await listAccountOrganizations()
    if (disposed) return
    organizations.value = items
    if (!items.some(item => item.id === draft.organizationId)) {
      draft.organizationId = items.find(item => item.id === authSession.user?.workspaceId)?.id ?? (items.length === 1 ? items[0]!.id : '')
    }
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : '企业列表加载失败'
  } finally {
    if (!disposed) loading.value = false
  }
}

async function submit() {
  if (saving.value || loading.value || result.value) return
  error.value = ''
  if (!organizations.value.some(item => item.id === draft.organizationId)
    || !activeDepartments.value.some(item => item.code === draft.departmentCode)
    || !businessRoles.value.some(item => item.code === draft.role)) {
    error.value = '请选择有效的企业、部门和业务角色'
    return
  }
  saving.value = true
  try {
    const created = await createAdminUser({
      email: draft.email.trim().toLowerCase(), displayName: draft.displayName.trim(),
      organizationId: draft.organizationId, departmentCode: draft.departmentCode, role: draft.role,
      ...(passwordMode.value === 'custom' ? { password: draft.password } : {}),
    })
    if (disposed) return
    draft.password = ''
    showPassword.value = false
    result.value = created
    emit('created', created.user)
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : '创建账号失败'
  } finally {
    if (!disposed) saving.value = false
  }
}

function reset() {
  result.value = null
  draft.email = ''
  draft.displayName = ''
  draft.password = ''
  passwordMode.value = 'automatic'
  showPassword.value = false
  error.value = ''
  copied.value = false
  copyError.value = ''
}

async function copyCredentials() {
  const account = result.value
  if (!account) return
  copyError.value = ''
  try {
    await navigator.clipboard.writeText(`账号：${account.user.email}\n密码：${account.initialPassword}`)
    if (!disposed && result.value === account) copied.value = true
  } catch {
    if (!disposed && result.value === account) copyError.value = '复制失败，请手动选中账号和密码复制'
  }
}

onMounted(loadOrganizations)
onBeforeUnmount(() => { disposed = true; reset() })
</script>

<template>
  <section class="account-creation">
    <h3>账号创建</h3>
    <div v-if="loading" role="status">正在加载可用企业...</div>
    <p v-if="error" class="account-error" role="alert">{{ error }} <button v-if="!organizations.length" type="button" class="btn btn-ghost" @click="loadOrganizations">重试</button></p>
    <div v-if="result" class="account-result">
      <h4>账号已创建</h4>
      <dl>
        <div><dt>姓名</dt><dd>{{ result.user.displayName }}</dd></div>
        <div><dt>企业</dt><dd>{{ organizations.find(item => item.id === draft.organizationId)?.name }}</dd></div>
        <div><dt>部门</dt><dd>{{ activeDepartments.find(item => item.code === draft.departmentCode)?.name }}</dd></div>
        <div><dt>业务角色</dt><dd>{{ businessRoles.find(item => item.code === draft.role)?.name }}</dd></div>
        <div><dt>登录账号</dt><dd data-testid="created-email">{{ result.user.email }}</dd></div>
        <div><dt>初始密码</dt><dd class="account-password" data-testid="created-password">{{ result.initialPassword }}</dd></div>
      </dl>
      <p role="status">初始密码仅本次显示，离开此模块后不再保留。请妥善交付给账号使用者。</p>
      <p v-if="copyError" class="account-error" role="alert">{{ copyError }}</p>
      <div class="account-actions">
        <button class="btn btn-primary" type="button" @click="copyCredentials">{{ copied ? '已复制' : '复制账号密码' }}</button>
        <button class="btn btn-ghost" type="button" @click="reset">继续创建</button>
      </div>
    </div>
    <form v-else-if="!loading" autocomplete="off" @submit.prevent="submit">
      <fieldset :disabled="saving">
        <div class="account-grid">
          <label for="account-email">登录邮箱<input id="account-email" v-model="draft.email" type="email" maxlength="254" required autocomplete="off" /></label>
          <label for="account-name">姓名<input id="account-name" v-model="draft.displayName" maxlength="80" required /></label>
          <label for="account-organization">所属企业<select id="account-organization" v-model="draft.organizationId" required><option value="" disabled>请选择企业</option><option v-for="item in organizations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <label for="account-department">所属部门<select id="account-department" v-model="draft.departmentCode" required><option value="" disabled>请选择部门</option><option v-for="item in activeDepartments" :key="item.id" :value="item.code">{{ item.name }}</option></select></label>
          <label for="account-role">业务角色<select id="account-role" v-model="draft.role" required><option v-for="item in businessRoles" :key="item.id" :value="item.code">{{ item.name }}</option></select></label>
          <div class="password-settings">
            <span>初始密码</span>
            <div class="password-modes"><label><input v-model="passwordMode" type="radio" value="automatic" name="password-mode" @change="draft.password = ''; showPassword = false" /> 自动生成</label><label><input v-model="passwordMode" type="radio" value="custom" name="password-mode" /> 自定义</label></div>
            <template v-if="passwordMode === 'custom'">
              <input id="account-password" v-model="draft.password" :type="showPassword ? 'text' : 'password'" aria-label="自定义密码" minlength="8" maxlength="128" required autocomplete="new-password" placeholder="8 至 128 个字符" />
              <label class="password-visibility"><input v-model="showPassword" type="checkbox" /> 显示密码</label>
            </template>
          </div>
        </div>
        <p v-if="!organizations.length" class="account-empty">暂无服务可用的企业</p>
        <p v-if="!activeDepartments.length" class="account-empty">暂无启用部门</p>
        <div class="account-actions"><button class="btn btn-primary" type="submit" :disabled="!organizations.length || !activeDepartments.length || !businessRoles.length">{{ saving ? '创建中...' : '创建账号' }}</button></div>
      </fieldset>
    </form>
  </section>
</template>

<style scoped>
.account-creation { padding: 20px 0; max-width: 900px; min-width: 0; color: #26332e; }
h3 { margin: 0 0 24px; font-size: 18px; }
h4 { margin: 0 0 20px; font-size: 16px; color: #176847; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.account-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 28px; }
.account-grid > label, .password-settings { display: flex; flex-direction: column; gap: 9px; font-size: 14px; min-width: 0; }
.account-grid input:not([type=radio]):not([type=checkbox]), select { box-sizing: border-box; width: 100%; min-width: 0; height: 42px; padding: 8px 10px; border: 1px solid #cbd5ce; border-radius: 6px; background: #fff; color: #26332e; font: inherit; }
input:focus-visible, select:focus-visible { outline: 2px solid #238358; outline-offset: 2px; }
.password-modes { min-height: 42px; display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
.password-modes label, .password-visibility { display: flex; align-items: center; gap: 6px; }
.password-visibility { font-size: 13px; }
.account-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 28px; }
.account-actions button { min-height: 40px; border-radius: 6px; }
.account-error { color: #b32635; overflow-wrap: anywhere; }
.account-empty, .account-result p { font-size: 14px; line-height: 1.7; }
.account-result { border-top: 2px solid #238358; padding-top: 20px; }
dl { margin: 0; }
dl > div { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 16px; padding: 12px 0; border-bottom: 1px solid #e4e9e6; }
dt { color: #69766d; font-size: 14px; }
dd { margin: 0; overflow-wrap: anywhere; }
.account-password { font-family: monospace; white-space: pre-wrap; user-select: all; }
@media (max-width: 640px) { .account-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
