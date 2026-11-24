<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Building2, Check, Pencil, Plus, Power, Trash2, X } from '@lucide/vue'
import PageHeader from '../../../shared/components/PageHeader.vue'
import { authSession } from '../../auth/session'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import {
  createEnterpriseDepartment,
  deleteEnterpriseDepartment,
  listEnterpriseDepartments,
  updateEnterpriseDepartment,
  type AdminDepartment,
} from '../api'

const departments = ref<AdminDepartment[]>([])
const departmentName = ref('')
const departmentNameInput = ref<HTMLInputElement | null>(null)
const departmentNameError = ref('')
const loading = ref(true)
const creating = ref(false)
const savingId = ref<string | null>(null)
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const confirmingDeleteId = ref<string | null>(null)
const error = ref('')
const notice = ref('')

const enterpriseName = computed(() => authSession.workspaces.find((workspace) => workspace.id === authSession.user?.workspaceId)?.name ?? '当前企业')
const activeCount = computed(() => departments.value.filter((department) => department.isActive).length)
const inactiveCount = computed(() => departments.value.length - activeCount.value)

async function loadDepartments() {
  loading.value = true
  error.value = ''
  try {
    departments.value = await listEnterpriseDepartments()
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取部门失败').message
  } finally {
    loading.value = false
  }
}

async function addDepartment() {
  if (creating.value) return
  const name = departmentName.value.trim()
  if (!name) {
    departmentNameError.value = '请输入部门名称'
    departmentNameInput.value?.focus()
    return
  }
  departmentNameError.value = ''
  creating.value = true
  error.value = ''
  notice.value = ''
  try {
    const created = await createEnterpriseDepartment({ name })
    departments.value = [created, ...departments.value]
    departmentName.value = ''
    notice.value = `已新增部门「${created.name}」`
  } catch (cause) {
    error.value = describeApiFailure(cause, '新增部门失败').message
  } finally {
    creating.value = false
  }
}

function startRename(department: AdminDepartment) {
  renamingId.value = department.id
  renameDraft.value = department.name
  confirmingDeleteId.value = null
  error.value = ''
  notice.value = ''
}

function cancelRename() {
  renamingId.value = null
  renameDraft.value = ''
}

async function saveName(department: AdminDepartment) {
  const name = renameDraft.value.trim()
  if (!name || savingId.value) return
  savingId.value = department.id
  error.value = ''
  notice.value = ''
  try {
    const saved = await updateEnterpriseDepartment(department.id, { name })
    departments.value = departments.value.map((item) => item.id === saved.id ? saved : item)
    cancelRename()
    notice.value = `已更新部门名称为「${saved.name}」`
  } catch (cause) {
    error.value = describeApiFailure(cause, '更新部门名称失败').message
  } finally {
    savingId.value = null
  }
}

async function toggleDepartment(department: AdminDepartment) {
  if (savingId.value) return
  savingId.value = department.id
  error.value = ''
  notice.value = ''
  try {
    const saved = await updateEnterpriseDepartment(department.id, { isActive: !department.isActive })
    departments.value = departments.value.map((item) => item.id === saved.id ? saved : item)
    notice.value = `已${saved.isActive ? '启用' : '停用'}部门「${saved.name}」`
  } catch (cause) {
    error.value = describeApiFailure(cause, '更新部门状态失败').message
  } finally {
    savingId.value = null
  }
}

function askDelete(department: AdminDepartment) {
  confirmingDeleteId.value = department.id
  renamingId.value = null
  error.value = ''
  notice.value = ''
}

async function removeDepartment(department: AdminDepartment) {
  if (savingId.value) return
  savingId.value = department.id
  error.value = ''
  notice.value = ''
  try {
    const removed = await deleteEnterpriseDepartment(department.id)
    departments.value = departments.value.filter((item) => item.id !== removed.id)
    confirmingDeleteId.value = null
    notice.value = removed.removedApprovalPolicies
      ? `已删除部门「${removed.name}」，同时清理 ${removed.removedApprovalPolicies} 条审批配置`
      : `已删除部门「${removed.name}」`
  } catch (cause) {
    error.value = describeApiFailure(cause, '删除部门失败').message
  } finally {
    savingId.value = null
  }
}

onMounted(loadDepartments)
</script>

<template>
  <PageHeader title="部门管理" description="维护当前企业使用的部门，成员、岗位和招聘记录会继续保留历史归属。">
    <template #meta>
      <span class="workspace-chip"><Building2 :size="15" :stroke-width="1.8" aria-hidden="true" />{{ enterpriseName }}</span>
    </template>
  </PageHeader>

  <section class="department-management" aria-labelledby="department-management-title">
    <div class="department-summary">
      <div>
        <h3 id="department-management-title">组织部门</h3>
        <p>停用后不会出现在新建记录的选择项中，已有数据仍会保留。</p>
      </div>
      <div class="department-counts" aria-label="部门统计">
        <span><strong>{{ activeCount }}</strong> 个启用</span>
        <span><strong>{{ inactiveCount }}</strong> 个停用</span>
      </div>
    </div>

    <form class="add-department" @submit.prevent="addDepartment">
      <label for="new-department-name">新增部门</label>
      <div class="add-department-controls">
        <input id="new-department-name" ref="departmentNameInput" v-model="departmentName" maxlength="80" autocomplete="off" placeholder="输入部门名称" :disabled="creating" :aria-invalid="Boolean(departmentNameError)" :aria-describedby="departmentNameError ? 'department-name-error' : undefined" @input="departmentNameError = ''" />
        <button class="btn btn-primary" type="submit" :disabled="creating">
          <Plus :size="15" :stroke-width="1.9" aria-hidden="true" />{{ creating ? '新增中...' : '新增部门' }}
        </button>
      </div>
      <p v-if="departmentNameError" id="department-name-error" class="field-error" role="alert">{{ departmentNameError }}</p>
    </form>

    <p v-if="notice" class="operation-notice" role="status"><Check :size="15" aria-hidden="true" />{{ notice }}</p>
    <p v-if="error" class="error-note" role="alert">{{ error }}</p>

    <div v-if="loading" class="loading-note" role="status">正在读取部门...</div>
    <div v-else class="table-wrap">
      <table>
        <thead><tr><th>部门名称</th><th>状态</th><th class="actions-column">操作</th></tr></thead>
        <tbody>
          <tr v-for="department in departments" :key="department.id">
            <td>
              <form v-if="renamingId === department.id" class="rename-form" @submit.prevent="saveName(department)">
                <input v-model="renameDraft" maxlength="80" aria-label="新部门名称" :disabled="savingId === department.id" />
                <button class="icon-button save" type="submit" aria-label="保存部门名称" :disabled="savingId === department.id || !renameDraft.trim()"><Check :size="16" aria-hidden="true" /></button>
                <button class="icon-button" type="button" aria-label="取消重命名" :disabled="savingId === department.id" @click="cancelRename"><X :size="16" aria-hidden="true" /></button>
              </form>
              <strong v-else>{{ department.name }}</strong>
            </td>
            <td><span class="status" :class="{ inactive: !department.isActive }">{{ department.isActive ? '启用' : '已停用' }}</span></td>
            <td class="actions-column">
              <div v-if="confirmingDeleteId === department.id" class="delete-confirm">
                <span>确认删除？</span>
                <button class="btn btn-danger" type="button" :disabled="savingId === department.id" @click="removeDepartment(department)">{{ savingId === department.id ? '删除中...' : '确认删除' }}</button>
                <button class="btn btn-ghost" type="button" :disabled="savingId === department.id" @click="confirmingDeleteId = null">取消</button>
              </div>
              <div v-else class="row-actions">
                <button class="btn btn-ghost" type="button" :disabled="savingId === department.id" @click="startRename(department)"><Pencil :size="14" aria-hidden="true" />重命名</button>
                <button class="btn btn-ghost" type="button" :disabled="savingId === department.id" @click="toggleDepartment(department)"><Power :size="14" aria-hidden="true" />{{ department.isActive ? '停用' : '启用' }}</button>
                <button class="btn btn-danger" type="button" :disabled="savingId === department.id" @click="askDelete(department)"><Trash2 :size="14" aria-hidden="true" />删除</button>
              </div>
            </td>
          </tr>
          <tr v-if="!departments.length"><td colspan="3" class="table-empty">当前企业还没有部门，请在上方新增</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.workspace-chip { display: inline-flex; align-items: center; gap: 6px; margin-top: 9px; color: #0f766e; font-size: 12px; font-weight: 600; }
.department-management { margin-top: 18px; border: 1px solid var(--border); border-radius: 8px; background: #fff; box-shadow: var(--shadow); overflow: hidden; }
.department-summary { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 17px 18px; border-bottom: 1px solid var(--border); }
.department-summary h3 { margin: 0; color: #1e293b; font-size: 15px; }
.department-summary p { margin: 5px 0 0; color: var(--muted); font-size: 12.5px; }
.department-counts { display: flex; gap: 16px; color: #64748b; font-size: 12px; white-space: nowrap; }
.department-counts strong { color: #0f766e; font-size: 17px; }
.add-department { display: grid; gap: 7px; padding: 16px 18px; border-bottom: 1px solid var(--border); background: #f8fbfa; }
.add-department label { color: #64748b; font-size: 11px; font-weight: 600; }
.field-error { margin: 0; color: #b91c1c; font-size: 12px; }
.add-department-controls { display: flex; gap: 8px; max-width: 580px; }
.add-department input, .rename-form input { min-width: 0; flex: 1; border: 1px solid #cbd5e1; border-radius: 7px; padding: 8px 10px; background: #fff; color: #1e293b; outline: none; }
.add-department input:focus, .rename-form input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-bg); }
.department-management :deep(.table-wrap) { border: 0; border-radius: 0; box-shadow: none; }
.department-management :deep(.table-wrap th), .department-management :deep(.table-wrap td) { padding: 13px 18px; }
.actions-column { width: 330px; }
.row-actions, .delete-confirm, .rename-form { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.delete-confirm span { color: #b45309; font-size: 12px; }
.rename-form { max-width: 430px; }
.status { display: inline-flex; align-items: center; gap: 6px; color: #047857; font-size: 12px; white-space: nowrap; }
.status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #10b981; }
.status.inactive { color: #64748b; }
.status.inactive::before { background: #94a3b8; }
.btn, .icon-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; }
.icon-button { width: 31px; height: 31px; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #475569; cursor: pointer; }
.icon-button.save { border-color: #99f6e4; background: #f0fdfa; color: #0f766e; }
.operation-notice { display: flex; align-items: center; gap: 6px; margin: 12px 18px 0; color: #047857; font-size: 12.5px; }
.error-note { margin: 12px 18px 0; }
.loading-note { margin: 16px 18px; }
button:disabled, input:disabled { cursor: not-allowed; opacity: .6; }
@media (max-width: 760px) {
  .department-summary { align-items: flex-start; flex-direction: column; gap: 10px; }
  .add-department-controls { max-width: none; }
  .actions-column { width: 260px; }
}
</style>
