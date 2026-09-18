<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { actionRequisition, createRequisition, loadDepartments, loadRequisitionRows, type ApiDepartment, type RequisitionAction, type RequisitionView } from '../api'
import { REQ_ACTION_HINT, REQ_ACTION_LABEL, validateRequisitionForm } from '../workflow'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import PageHeader from '../../../shared/components/PageHeader.vue'
import PageFeedback from '../../../shared/components/workflow/PageFeedback.vue'
import RequisitionTable from '../components/RequisitionTable.vue'

const router = useRouter()
const route = useRoute()
const rows = ref<RequisitionView[]>([])
const filter = ref('all')
const loading = ref(true)
const error = ref('')
const feedback = ref('')
const showCreate = ref(false)
const saving = ref(false)
const actingId = ref('')
const form = ref({ title: '', departmentId: '', hiringManagerId: '', headcount: 1, employmentType: 'full_time', workMode: 'hybrid', location: '', salaryRangeMin: '', salaryRangeMax: '', justification: '' })
const fieldError = ref('')
const departments = ref<ApiDepartment[]>([])

const visibleRows = computed(() => rows.value.filter((row) => filter.value === 'all' || row.status === filter.value))

function clearFlags() { error.value = ''; feedback.value = ''; fieldError.value = '' }

async function refresh() {
  loading.value = true
  clearFlags()
  try {
    const [requisitionRows, departmentRows] = await Promise.all([loadRequisitionRows(), loadDepartments()])
    rows.value = requisitionRows
    departments.value = departmentRows
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取招聘需求失败').message
  } finally {
    loading.value = false
  }
}

async function submitCreate() {
  if (saving.value) return
  const payload = {
    title: form.value.title.trim(),
    departmentId: form.value.departmentId.trim(),
    hiringManagerId: form.value.hiringManagerId.trim() || undefined,
    headcount: Number(form.value.headcount),
    employmentType: form.value.employmentType,
    workMode: form.value.workMode,
    location: form.value.location.trim() || undefined,
    justification: form.value.justification.trim(),
    salaryRange: {
      ...(form.value.salaryRangeMin ? { min: { amount: Number(form.value.salaryRangeMin), currency: 'CNY' } } : {}),
      ...(form.value.salaryRangeMax ? { max: { amount: Number(form.value.salaryRangeMax), currency: 'CNY' } } : {}),
    },
  }
  const validation = validateRequisitionForm(payload)
  if (validation) {
    fieldError.value = validation
    return
  }
  saving.value = true
  clearFlags()
  try {
    await createRequisition(payload)
    feedback.value = '需求草稿已创建'
    showCreate.value = false
    form.value = { title: '', departmentId: '', hiringManagerId: '', headcount: 1, employmentType: 'full_time', workMode: 'hybrid', location: '', salaryRangeMin: '', salaryRangeMax: '', justification: '' }
    await refresh()
  } catch (cause) {
    error.value = describeApiFailure(cause, '创建需求失败').message
  } finally {
    saving.value = false
  }
}

async function runAction(row: RequisitionView, action: RequisitionAction, reason?: string) {
  if (actingId.value) return
  const id = row.entityId
  actingId.value = id
  clearFlags()
  try {
    const done = await actionRequisition(id, action, reason)
    feedback.value = `${row.title}：${REQ_ACTION_LABEL[action]}成功，当前状态 ${done.status}`
    await refresh()
  } catch (cause) {
    error.value = describeApiFailure(cause, '需求操作失败').message
  } finally {
    actingId.value = ''
  }
}

function openDetail(row: RequisitionView) {
  router.push({ name: 'requisition-detail', params: { id: row.entityId } })
}

const actionDescription = computed(() => {
  const map: Record<RequisitionAction, string> = { submit: '草稿提交后进入审批', resubmit: '驳回后可重新提交', approve: '全部审批通过后状态变为已通过', reject: '驳回需填写原因', withdraw: '撤回后进入已撤回', close: '关闭后归档该需求', cancel: '取消草稿/待审批/已驳回需求', convert: '将已通过需求转换为岗位' }
  return actingAction.value ? (map[actingAction.value] || '') : ''
})

const actingAction = ref<RequisitionAction | ''>('')

function previewAction(action: RequisitionAction) {
  actingAction.value = action
}

function clearActionDescription() {
  actingAction.value = ''
}

onMounted(async () => {
  await refresh()
  if (route.query.create === '1') showCreate.value = true
})
</script>

<template>
  <PageHeader title="需求管理 · 审批" description="统一管理部门招聘编制与审批进度">
    <div class="inline-actions">
      <button class="btn btn-ghost" type="button" @click="refresh">刷新</button>
      <button class="btn btn-primary" type="button" @click="showCreate = !showCreate">{{ showCreate ? '取消新建' : '新建需求' }}</button>
    </div>
    <select v-model="filter" class="filter" aria-label="按状态筛选">
      <option value="all">全部状态</option>
      <option value="draft">草稿</option>
      <option value="pending_approval">待审批</option>
      <option value="approved">已通过</option>
      <option value="rejected">已驳回</option>
      <option value="withdrawn">已撤回</option>
      <option value="converted">已转岗位</option>
      <option value="closed">已关闭</option>
      <option value="cancelled">已取消</option>
    </select>
  </PageHeader>

  <section v-if="showCreate" class="form-panel">
    <div class="section-title">新建招聘需求</div>
    <div v-if="fieldError" class="error-note">{{ fieldError }}</div>
    <div class="form-grid">
      <div class="form-field"><label>岗位名称 <span class="required">*</span></label><input v-model="form.title" placeholder="例如：高级后端工程师" /></div>
      <div class="form-field"><label>部门 <span class="required">*</span></label><select v-model="form.departmentId"><option value="">请选择部门</option><option v-for="department in departments" :key="department.id" :value="department.code">{{ department.name }}（{{ department.code }}）</option></select></div>
      <div class="form-field"><label>招聘负责人</label><input v-model="form.hiringManagerId" placeholder="例如：张三" /></div>
      <div class="form-field"><label>招聘人数 <span class="required">*</span></label><input v-model.number="form.headcount" type="number" min="1" /></div>
      <div class="form-field"><label>用工类型 <span class="required">*</span></label><select v-model="form.employmentType"><option value="full_time">全职</option><option value="part_time">兼职</option><option value="internship">实习</option></select></div>
      <div class="form-field"><label>工作模式 <span class="required">*</span></label><select v-model="form.workMode"><option value="hybrid">混合办公</option><option value="onsite">现场办公</option><option value="remote">远程</option></select></div>
      <div class="form-field"><label>工作地点</label><input v-model="form.location" placeholder="例如：北京/远程" /></div>
      <div class="form-field"><label>薪资范围（最小值）</label><input v-model="form.salaryRangeMin" type="number" min="0" placeholder="例如：18000" /></div>
      <div class="form-field"><label>薪资范围（最大值）</label><input v-model="form.salaryRangeMax" type="number" min="0" placeholder="例如：30000" /></div>
      <div class="form-field" style="grid-column: 1 / -1"><label>招聘理由 <span class="required">*</span></label><textarea v-model="form.justification" rows="3" placeholder="说明招聘背景、业务影响和到岗时间"></textarea></div>
    </div>
    <div class="form-tip">必填字段不完整时会阻止提交；草稿保存后可继续编辑。</div>
    <div class="inline-actions" style="margin-top:14px">
      <button class="btn btn-primary" type="button" :disabled="saving" @click="submitCreate">{{ saving ? '保存中...' : '保存草稿' }}</button>
      <button class="btn btn-ghost" type="button" :disabled="saving" @click="showCreate = false">取消</button>
    </div>
  </section>

  <PageFeedback :feedback="feedback" :error="error" @clear-feedback="feedback = ''" @clear-error="error = ''" />
  <div v-if="loading" class="loading-note">正在读取招聘需求...</div>
  <RequisitionTable v-else :rows="visibleRows" :acting-id="actingId" @action="runAction" @open="openDetail" />

  <div v-if="actingAction" class="action-help" @click.self="clearActionDescription">
    <div class="action-help-inner">
      <div class="section-title">{{ REQ_ACTION_LABEL[actingAction] }}说明</div>
      <p>{{ actionDescription }}</p>
      <p class="hint">{{ REQ_ACTION_HINT[actingAction] }}</p>
      <button class="btn btn-ghost" type="button" @click="clearActionDescription">关闭</button>
    </div>
  </div>
</template>
