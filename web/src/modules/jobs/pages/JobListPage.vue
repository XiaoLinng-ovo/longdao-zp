<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { ArrowRight, X, Unlink, Trash2, RefreshCw } from '@lucide/vue'
import { authSession } from '../../auth/session'
import { useRoute, useRouter } from 'vue-router'
import { externalJobPublishingEnabled, recruitmentRequestsEnabled } from '../../../shared/config/features'
import { apiClient, ApiClientError } from '../../../shared/api'
import { createJob, deleteJob, jobAction, loadJobRelatedRecords, loadJobs, type JobAction, type JobRelatedRecord, type JobView } from '../api'
import { loadDepartments, type ApiDepartment } from '../../requisitions/api'
import { deleteApplication, detachResumeImportJob } from '../../candidates/api'
import { JOB_ACTION_LABEL, isJobActionVisible } from '../workflow'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import PageHeader from '../../../shared/components/PageHeader.vue'
import PageFeedback from '../../../shared/components/workflow/PageFeedback.vue'
import JobTable from '../components/JobTable.vue'
import { statusLabel } from '../../../shared/utils/labels'

const router = useRouter()
const route = useRoute()
const rows = ref<JobView[]>([])
const loading = ref(true)
const error = ref('')
const feedback = ref('')
const actingId = ref('')
const deleteTarget = ref<JobView | null>(null)
const deleting = ref(false)
const relatedJob = ref<JobView | null>(null)
const relatedHeading = ref<HTMLHeadingElement | null>(null)
const relatedRecords = ref<JobRelatedRecord[]>([])
const relatedLoading = ref(false)
const relatedError = ref('')
const processingRecord = ref('')
async function processRelatedRecord(record: JobRelatedRecord) {
  if (!canDelete.value || !relatedJob.value || processingRecord.value) return
  const message = record.kind === 'resume_import'
    ? '确认解除此导入批次与岗位的关联吗？导入历史、候选人、简历及申请均保留，解除后不能继续向此批次上传文件。'
    : `确认删除申请“${record.title}”吗？删除后不可恢复，将清理该申请的专属简历和分析资料；若这是最后一条申请，候选人档案也会一并删除。其他岗位申请及共用资料将保留，已有面试、Offer 或入职记录的申请不能直接删除。`
  if (!window.confirm(message)) return
  processingRecord.value = record.kind + record.id
  relatedError.value = ''
  try {
    if (record.kind === 'resume_import') {
      await detachResumeImportJob(record.id)
      feedback.value = '已解除岗位关联，导入历史及候选人资料已保留。'
    } else {
      const result = await deleteApplication(record.applicationId || record.id)
      feedback.value = result.candidateDeleted
        ? '申请、候选人档案及相关资料已一并删除。'
        : '申请及专属资料已删除，其他岗位申请及共用资料已保留。'
    }
    error.value = ''
    await showRelatedRecords(relatedJob.value)
  } catch (cause) { relatedError.value = describeApiFailure(cause, '处理关联记录失败').message }
  finally { processingRecord.value = '' }
}
let relatedRequest = 0

async function showRelatedRecords(row: JobView, moveFocus = false) {
  const request = ++relatedRequest
  relatedJob.value = row
  relatedRecords.value = []
  relatedError.value = ''
  relatedLoading.value = true
  if (moveFocus) void nextTick(() => relatedHeading.value?.focus())
  try {
    const records = await loadJobRelatedRecords(row.entityId || row.id)
    if (request === relatedRequest) relatedRecords.value = records
  } catch (cause) {
    if (request === relatedRequest) relatedError.value = describeApiFailure(cause, '读取关联业务失败').message
  } finally {
    if (request === relatedRequest) relatedLoading.value = false
  }
}

function closeRelatedRecords() {
  relatedRequest++
  relatedJob.value = null
}

function relatedLocation(record: JobRelatedRecord) {
  return record.kind === 'application'
    ? { name: 'candidate-detail', params: { id: record.candidateId }, query: { applicationId: record.applicationId || record.id } }
    : { name: 'resume-import-detail', params: { id: record.id } }
}
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
    if ((relatedJob.value?.entityId || relatedJob.value?.id) === id) closeRelatedRecords()
  } catch (cause) {
    error.value = describeApiFailure(cause, '删除岗位失败').message
    if (cause instanceof ApiClientError && cause.code === 'JOB_IN_USE') {
      deleteTarget.value = null
      void showRelatedRecords(row, true)
    }
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
  if (typeof route.query.relatedJobId === 'string') {
    const row = rows.value.find(item => item.entityId === route.query.relatedJobId || item.id === route.query.relatedJobId)
    if (row) await showRelatedRecords(row, true)
  }
  if (route.query.create === '1') openCreateJob()
})
</script>

<template>
  <p v-if="route.query.notice === 'recruitment-requests-disabled'" class="muted" role="status">
    需求申请审批已停用，已为你打开岗位管理。可直接新建岗位；录用审批与 Offer 仍正常保留。
  </p>
  <PageHeader title="岗位管理">
    <div class="inline-actions">
      <button class="btn btn-primary" type="button" :disabled="Boolean(actingId)" @click="openCreateJob">新建岗位</button>
      <button class="btn btn-ghost" type="button" :disabled="Boolean(actingId) || loading" @click="refresh">刷新</button>
    </div>
  </PageHeader>
  <PageFeedback :feedback="feedback" :error="error" @clear-feedback="feedback = ''" @clear-error="error = ''" />
  <section v-if="relatedJob" class="job-related-records" aria-labelledby="job-related-title">
    <div class="related-heading">
      <h3 id="job-related-title" ref="relatedHeading" tabindex="-1">{{ relatedJob.title }} · 关联业务</h3>
      <div class="inline-actions">
        <button v-if="canDelete && !relatedLoading && !relatedRecords.length && !relatedError" class="btn btn-danger" type="button" @click="requestDelete(relatedJob)"><Trash2 :size="14" />删除岗位</button>
        <button class="btn btn-ghost" type="button" :disabled="relatedLoading || !!processingRecord" aria-label="刷新关联业务" title="刷新关联业务" @click="showRelatedRecords(relatedJob)"><RefreshCw :size="16" /></button>
        <button class="btn btn-ghost" type="button" :disabled="!!processingRecord" aria-label="关闭关联业务" title="关闭关联业务" @click="closeRelatedRecords"><X :size="16" /></button>
      </div>
    </div>
    <div v-if="relatedLoading" class="loading-note" role="status">正在读取关联业务...</div>
    <div v-else-if="relatedError" class="error-note" role="alert">{{ relatedError }} <button class="btn btn-ghost" type="button" @click="showRelatedRecords(relatedJob)">重试</button></div>
    <div v-else-if="!relatedRecords.length" class="muted" role="status">关联记录已处理，可以继续删除岗位。</div>
    <div v-if="!relatedLoading && relatedRecords.length" class="table-wrap related-table">
      <table><thead><tr><th>业务类型</th><th>关联记录</th><th>状态</th><th>操作</th></tr></thead>
        <tbody><tr v-for="record in relatedRecords" :key="record.kind + record.id">
          <td>{{ record.kind === 'application' ? '候选人申请' : '简历导入批次' }}</td>
          <td class="related-title">{{ record.title }}</td><td>{{ statusLabel(record.status) }}</td>
          <td><div class="related-actions">
            <RouterLink class="btn btn-ghost related-link" :to="relatedLocation(record)">查看详情 <ArrowRight :size="14" aria-hidden="true" /></RouterLink>
            <button v-if="canDelete" class="btn btn-ghost related-link" type="button" :disabled="!!processingRecord" @click="processRelatedRecord(record)"><Unlink v-if="record.kind === 'resume_import'" :size="14" /><Trash2 v-else :size="14" />{{ processingRecord === record.kind + record.id ? '处理中...' : record.kind === 'resume_import' ? '解除岗位关联' : '删除申请' }}</button>
          </div></td>
        </tr></tbody>
      </table>
    </div>
  </section>
  <div v-if="loading" class="loading-note">正在读取岗位...</div>
  <JobTable v-else :rows="rows" :acting-id="actingId" :can-delete="canDelete" @delete="requestDelete" @action="runAction" @open="openJob" @open-doc="openDoc" />

  <div v-if="deleteTarget" class="overlay" role="presentation" @click.self="cancelDelete" @keydown.esc="cancelDelete">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-job-title">
      <h3 id="delete-job-title">删除岗位</h3>
      <p>确定删除岗位“{{ deleteTarget.title }}”吗？</p>
      <p>删除后无法恢复，岗位说明书、JD 历史版本及评分规则关联也会删除；评分 Skill 本身不会删除。</p>
      <p>存在候选人申请或简历导入记录的岗位不能直接删除。候选人、简历及面试资料不会被自动删除。</p>
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
.job-related-records { margin-bottom: 20px; padding: 12px 0; border-bottom: 1px solid var(--border, #dce5ee); }
.related-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.related-heading h3 { margin: 0; font-size: 15px; overflow-wrap: anywhere; scroll-margin-top: 72px; }
.related-heading h3:focus { outline: none; }
.related-table { max-height: 320px; overflow: auto; margin-top: 10px; }
.related-table table { width: 100%; min-width: 560px; }
.related-title { overflow-wrap: anywhere; }
.related-link { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; text-decoration: none; }
.related-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.related-heading .inline-actions { flex-shrink: 0; }
@media (max-width: 640px) {
  .related-table table { min-width: 0; table-layout: fixed; }
  .related-table th, .related-table td { padding-inline: 6px; white-space: normal; overflow-wrap: anywhere; }
  .related-table th:first-child { width: 4.5rem; }
  .related-table th:nth-child(3) { width: 3rem; }
  .related-table th:last-child { width: 6.75rem; }
  .related-link { max-width: 100%; padding-inline: 5px; white-space: normal; text-align: center; justify-content: center; }
  .related-link :deep(svg) { display: none; }
}
.job-create-dialog {
  max-width: 860px;
  max-height: min(86vh, 760px);
  overflow-y: auto;
}
</style>
