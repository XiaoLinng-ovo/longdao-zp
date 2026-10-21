<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { authSession } from '../../auth/session'
import { useRoute, useRouter } from 'vue-router'
import { externalJobPublishingEnabled, recruitmentRequestsEnabled } from '../../../shared/config/features'
import { apiClient } from '../../../shared/api'
import { createJob, deleteJob, jobAction, loadJobs, type JobAction, type JobView } from '../api'
import { loadDepartments, type ApiDepartment } from '../../requisitions/api'
import { JOB_ACTION_LABEL, isJobActionVisible } from '../workflow'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import PageHeader from '../../../shared/components/PageHeader.vue'
import PageFeedback from '../../../shared/components/workflow/PageFeedback.vue'
import JobTable from '../components/JobTable.vue'

const router = useRouter()
const route = useRoute()
const rows = ref<JobView[]>([])
const loading = ref(true)
const error = ref('')
const feedback = ref('')
const actingId = ref('')
const deleteTarget = ref<JobView | null>(null)
const deleting = ref(false)
const canDelete = computed(() => ['recruiter', 'admin', 'hr_admin'].includes(authSession.user?.role ?? ''))
const showCreateJob = ref(false)
const creatingJob = ref(false)
const approvedRequests = ref<Array<{ id: string; title: string }>>([])
const departments = ref<ApiDepartment[]>([])
const createForm = ref({ recruitmentRequestId: '', title: '', departmentId: '', hiringManagerId: '', employmentType: 'full_time', workMode: 'hybrid', location: '', headcount: 1 })

function clearFlags() { error.value = ''; feedback.value = '' }

async function refresh() {
  if (deleting.value) return
  loading.value = true
  clearFlags()
  try {
    const [jobs, requests, depts] = await Promise.all([loadJobs(), recruitmentRequestsEnabled ? apiClient.getJson<any[]>('/recruitment-requests').then(res => res.data).catch(() => []) : Promise.resolve([]), loadDepartments().catch(() => [])])
    rows.value = jobs
    approvedRequests.value = requests.filter((item) => item.status === 'approved').map((item) => ({ id: item.id, title: item.title }))
    departments.value = depts
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取岗位失败').message
  } finally {
    loading.value = false
  }
}

async function runAction(row: JobView, action: JobAction, suppliedReason?: string) {
  if (actingId.value || !isJobActionVisible(action)) return
  const reason = suppliedReason
  const id = row.entityId
  actingId.value = id
  clearFlags()
  try {
    const done = await jobAction(id, action, reason)
    feedback.value = `${row.title}：${JOB_ACTION_LABEL[action]}成功，当前状态 ${done.status}`
    await refresh()
  } catch (cause) {
    error.value = describeApiFailure(cause, '岗位操作失败').message
  } finally {
    actingId.value = ''
  }
}

function requestDelete(row: JobView) {
  if (!canDelete.value || actingId.value) return
  clearFlags()
  deleteTarget.value = row
}

function cancelDelete() {
  if (!deleting.value) deleteTarget.value = null
}

async function confirmDelete() {
  if (!canDelete.value || !deleteTarget.value || deleting.value || actingId.value) return
  const row = deleteTarget.value
  const id = row.entityId || row.id
  deleting.value = true
  actingId.value = id
  clearFlags()
  try {
    await deleteJob(id)
    rows.value = rows.value.filter((item) => (item.entityId || item.id) !== id)
    deleteTarget.value = null
    feedback.value = `岗位“${row.title}”已删除`
  } catch (cause) {
    error.value = describeApiFailure(cause, '删除岗位失败').message
  } finally {
    deleting.value = false
    actingId.value = ''
  }
}

function openJob(row: JobView) {
  router.push({ name: 'job-detail', params: { id: row.entityId } })
}

function openDoc(row: JobView, kind: 'spec' | 'jd') {
  router.push({ name: 'job-detail', params: { id: row.entityId || row.id }, query: { doc: kind } })
}

function openCreateJob() {
  const prefilledId = recruitmentRequestsEnabled && typeof route.query.recruitmentRequestId === 'string' ? route.query.recruitmentRequestId : ''
  createForm.value = { recruitmentRequestId: prefilledId, title: '', departmentId: '', hiringManagerId: '', employmentType: 'full_time', workMode: 'hybrid', location: '', headcount: 1 }
  showCreateJob.value = true
  clearFlags()
}

async function submitCreateJob() {
  if (creatingJob.value) return
  const form = createForm.value
  if (!form.title.trim() || !form.departmentId.trim()) { error.value = '请填写岗位名称与部门'; return }
  creatingJob.value = true
  clearFlags()
  try {
    await createJob({
      ...(recruitmentRequestsEnabled && form.recruitmentRequestId.trim() ? { recruitmentRequestId: form.recruitmentRequestId.trim() } : {}),
      title: form.title.trim(),
      departmentId: form.departmentId.trim(),
      hiringManagerId: form.hiringManagerId.trim() || undefined,
      headcount: Number(form.headcount),
      employmentType: form.employmentType,
      workMode: form.workMode,
      location: form.location.trim() || undefined,
    })
    feedback.value = '岗位已创建，可继续完善说明书与 JD'
    showCreateJob.value = false
    await refresh()
  } catch (cause) {
    error.value = describeApiFailure(cause, '创建岗位失败').message
  } finally {
    creatingJob.value = false
  }
}

onMounted(async () => {
  await refresh()
  if (route.query.create === '1') openCreateJob()
})
</script>

<template>
  <p v-if="route.query.notice === 'recruitment-requests-disabled'" class="muted" role="status">
    需求申请审批已停用，已为你打开岗位管理。可直接新建岗位；录用审批与 Offer 仍正常保留。
  </p>
  <PageHeader title="岗位管理" :description="externalJobPublishingEnabled ? '维护职位说明、JD 与发布状态' : '维护岗位信息、职位说明书与 JD'">
    <div class="inline-actions">
      <button class="btn btn-primary" type="button" :disabled="Boolean(actingId)" @click="openCreateJob">新建岗位</button>
      <button class="btn btn-ghost" type="button" :disabled="Boolean(actingId) || loading" @click="refresh">刷新</button>
    </div>
  </PageHeader>
  <PageFeedback :feedback="feedback" :error="error" @clear-feedback="feedback = ''" @clear-error="error = ''" />
  <div v-if="loading" class="loading-note">正在读取岗位...</div>
  <JobTable v-else :rows="rows" :acting-id="actingId" :can-delete="canDelete" @delete="requestDelete" @action="runAction" @open="openJob" @open-doc="openDoc" />

  <div v-if="deleteTarget" class="overlay" role="presentation" @click.self="cancelDelete" @keydown.esc="cancelDelete">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-job-title">
      <h3 id="delete-job-title">删除岗位</h3>
      <p>确定删除岗位“{{ deleteTarget.title }}”吗？</p>
      <p>删除后无法恢复，岗位说明书、JD 历史版本及评分规则关联也会删除；评分 Skill 本身不会删除。</p>
      <p>已有候选人申请的岗位不能直接删除。候选人、简历及面试资料不会被自动删除。</p>
      <div v-if="error" class="error-note" role="alert">{{ error }}</div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="deleting" @click="cancelDelete">取消</button>
        <button class="btn btn-danger" type="button" :disabled="deleting" @click="confirmDelete">{{ deleting ? '删除中...' : '确认删除' }}</button>
      </div>
    </div>
  </div>

  <div v-if="showCreateJob" class="overlay" role="presentation" @click.self="showCreateJob = false">
    <div class="dialog job-create-dialog" role="dialog" aria-modal="true">
      <h3>新建岗位</h3>
      <div v-if="error" class="error-note">{{ error }}</div>
      <div class="form-grid">
        <div v-if="recruitmentRequestsEnabled" class="form-field">
          <label>招聘需求（可选）</label>
          <select v-model="createForm.recruitmentRequestId">
            <option value="">不关联招聘需求</option>
            <option v-for="item in approvedRequests" :key="item.id" :value="item.id">{{ item.title }}</option>
          </select>
        </div>
        <div class="form-field"><label>岗位名称 <span class="required">*</span></label><input v-model="createForm.title" /></div>
        <div class="form-field"><label>部门 <span class="required">*</span></label><select v-model="createForm.departmentId"><option value="" disabled>请选择部门</option><option v-for="dept in departments" :key="dept.id" :value="dept.code" :disabled="!dept.isActive">{{ dept.name }}</option></select></div>
        <div class="form-field"><label>招聘负责人</label><input v-model="createForm.hiringManagerId" placeholder="如：张三、李四（支持多位负责人）" /></div>
        <div class="form-field"><label>招聘人数 <span class="required">*</span></label><input v-model.number="createForm.headcount" type="number" min="1" /></div>
        <div class="form-field"><label>用工类型</label><select v-model="createForm.employmentType"><option value="full_time">全职</option><option value="part_time">兼职</option><option value="internship">实习</option></select></div>
        <div class="form-field"><label>工作模式</label><select v-model="createForm.workMode"><option value="hybrid">混合办公</option><option value="onsite">现场办公</option><option value="remote">远程</option></select></div>
        <div class="form-field"><label>工作地点</label><input v-model="createForm.location" /></div>
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="creatingJob" @click="showCreateJob = false">取消</button>
        <button class="btn btn-primary" type="button" :disabled="creatingJob" @click="submitCreateJob">{{ creatingJob ? '创建中...' : '创建岗位' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.job-create-dialog {
  max-width: 860px;
  max-height: min(86vh, 760px);
  overflow-y: auto;
}
</style>
