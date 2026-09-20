<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiClient } from '../../../shared/api'
import { createJob, jobAction, loadJobs, type JobAction, type JobView } from '../api'
import { loadDepartments, type ApiDepartment } from '../../requisitions/api'
import { JOB_ACTION_LABEL } from '../workflow'
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
const showCreateJob = ref(false)
const creatingJob = ref(false)
const approvedRequests = ref<Array<{ id: string; title: string }>>([])
const departments = ref<ApiDepartment[]>([])
const createForm = ref({ recruitmentRequestId: '', title: '', departmentId: '', hiringManagerId: '', employmentType: 'full_time', workMode: 'hybrid', location: '', headcount: 1 })

function clearFlags() { error.value = ''; feedback.value = '' }

async function refresh() {
  loading.value = true
  clearFlags()
  try {
    const [jobs, requests, depts] = await Promise.all([loadJobs(), apiClient.getJson<any[]>('/recruitment-requests').then(res => res.data).catch(() => []), loadDepartments().catch(() => [])])
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
  if (actingId.value) return
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

function openJob(row: JobView) {
  router.push({ name: 'job-detail', params: { id: row.entityId } })
}

function openDoc(row: JobView, kind: 'spec' | 'jd') {
  router.push({ name: 'job-detail', params: { id: row.entityId || row.id }, query: { doc: kind } })
}

function openCreateJob() {
  const prefilledId = typeof route.query.recruitmentRequestId === 'string' ? route.query.recruitmentRequestId : ''
  createForm.value = { recruitmentRequestId: prefilledId, title: '', departmentId: '', hiringManagerId: '', employmentType: 'full_time', workMode: 'hybrid', location: '', headcount: 1 }
  showCreateJob.value = true
  if (!approvedRequests.value.length) void refresh()
}

async function submitCreateJob() {
  if (creatingJob.value) return
  const form = createForm.value
  if (!form.recruitmentRequestId.trim()) { error.value = '请选择已审批需求'; return }
  if (!form.title.trim() || !form.departmentId.trim()) { error.value = '请填写岗位名称与部门'; return }
  creatingJob.value = true
  clearFlags()
  try {
    await createJob({
      recruitmentRequestId: form.recruitmentRequestId.trim(),
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
  <PageHeader title="岗位管理" description="维护职位说明、JD 与发布状态">
    <div class="inline-actions">
      <button class="btn btn-primary" type="button" @click="openCreateJob">新建岗位</button>
      <button class="btn btn-ghost" type="button" @click="refresh">刷新</button>
    </div>
  </PageHeader>
  <PageFeedback :feedback="feedback" :error="error" @clear-feedback="feedback = ''" @clear-error="error = ''" />
  <div v-if="loading" class="loading-note">正在读取岗位...</div>
  <JobTable v-else :rows="rows" :acting-id="actingId" @action="runAction" @open="openJob" @open-doc="openDoc" />

  <div v-if="showCreateJob" class="overlay" role="presentation" @click.self="showCreateJob = false">
    <div class="dialog job-create-dialog" role="dialog" aria-modal="true">
      <h3>新建岗位</h3>
      <div v-if="error" class="error-note">{{ error }}</div>
      <div class="form-grid">
        <div class="form-field">
          <label>招聘需求 <span class="required">*</span></label>
          <select v-model="createForm.recruitmentRequestId">
            <option value="" disabled>选择已审批需求</option>
            <option v-for="item in approvedRequests" :key="item.id" :value="item.id">{{ item.title }}</option>
          </select>
        </div>
        <div class="form-field"><label>岗位名称 <span class="required">*</span></label><input v-model="createForm.title" /></div>
        <div class="form-field"><label>部门 <span class="required">*</span></label><select v-model="createForm.departmentId"><option value="" disabled>请选择部门</option><option v-for="dept in departments" :key="dept.id" :value="dept.code" :disabled="!dept.isActive">{{ dept.name }}</option></select></div>
        <div class="form-field"><label>负责人</label><input v-model="createForm.hiringManagerId" /></div>
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
