<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiClient } from '../../../shared/api'
import { createJd, createSpec, generateJobDescription, generateJobSpec, getJob, jobAction, listJobDescriptionVersions, listJobSpecVersions, updateJob, type ApiJob, type ApiJobJdVersion, type ApiJobSpecVersion, type JobAction, type JobRequirement, type UpdateJobInput } from '../api'
import { JOB_ACTION_LABEL, JOB_REASON_REQUIRED, JOB_STATUS_LABEL, editableFieldsForStatus, jobActionsFor, jobPublishHint, jobStatusLabel, validateJobForm } from '../workflow'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { actionLabel, employmentTypeLabel, statusLabel, workModeLabel } from '../../../shared/utils/labels'
import { loadWorkflowEvents, type WorkflowEvent } from '../../../shared/api/workflow-events'
import { loadDepartments, type ApiDepartment } from '../../requisitions/api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import PageFeedback from '../../../shared/components/workflow/PageFeedback.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'

const route = useRoute()
const router = useRouter()
const jobId = computed(() => String(route.params.id || ''))
const job = ref<ApiJob | null>(null)
const departments = ref<ApiDepartment[]>([])
const specConfirmed = ref(false)
const jdConfirmed = ref(false)
const approvedRequestId = computed(() => (job.value ? job.value.recruitmentRequestId || route.query.recruitmentRequestId || '' : ''))
const requestApproved = ref(false)
const requestTitle = ref('')
const loading = ref(true)
const error = ref('')
const feedback = ref('')
const acting = ref(false)

const showEdit = ref(false)
const editForm = ref({ title: '', departmentId: '', hiringManagerId: '', employmentType: 'full_time', workMode: 'hybrid', location: '', headcount: 1 })
const editingSpec = ref(false)
const editingJd = ref(false)
const specForm = ref({ title: '', summary: '', responsibilitiesText: '', requirementsText: '', skillsText: '' })
const jdForm = ref({ language: 'zh-CN', content: '' })
const specVersions = ref<ApiJobSpecVersion[]>([])
const jdVersions = ref<ApiJobJdVersion[]>([])
const auditEvents = ref<WorkflowEvent[]>([])
const loadingAudit = ref(false)
const editError = ref('')

const pendingAction = ref<JobAction | null>(null)
const reason = ref('')

const actions = computed<JobAction[]>(() => job.value ? jobActionsFor(job.value) : [])
const publishHint = computed(() => (job.value ? jobPublishHint(job.value) : ''))
const publishDisabled = computed(() => {
  if (!job.value) return true
  if (job.value.status === 'closed') return true
  if (!approvedRequestId.value || !requestApproved.value) return true
  if (!specConfirmed.value || !jdConfirmed.value) return true
  return false
})
const editableFields = computed(() => (job.value ? editableFieldsForStatus(job.value.status) : []))

function clearFlags() { error.value = ''; feedback.value = ''; editError.value = '' }

function splitList(text: string): string[] {
  return text.split(/[，,、\n]/).map((item) => item.trim()).filter(Boolean)
}

function requirementsText(requirements: JobRequirement[]): string {
  return requirements.map((item) => item.description ? `${item.label}：${item.description}` : item.label).join('\n')
}

function parseRequirements(text: string): JobRequirement[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.search(/[：:]/)
    if (separator < 0) return { label: line, required: true }
    return { label: line.slice(0, separator).trim(), description: line.slice(separator + 1).trim(), required: true }
  }).filter((item) => item.label)
}

function resetSpecForm() {
  const spec = job.value?.spec
  specForm.value = {
    title: spec?.title || job.value?.title || '',
    summary: spec?.summary || '',
    responsibilitiesText: (spec?.responsibilities || []).join('\n'),
    requirementsText: requirementsText(spec?.requirements || []),
    skillsText: (spec?.skills || []).join('、'),
  }
}

function resetJdForm() {
  jdForm.value = { language: job.value?.jd?.language || 'zh-CN', content: job.value?.jd?.content || '' }
}

async function loadAuditEvents(jobIdValue: string) {
  loadingAudit.value = true
  auditEvents.value = []
  try {
    auditEvents.value = await loadWorkflowEvents('job', 100).then((rows) => rows.filter((item) => item.subjectId === jobIdValue))
  } catch {
    auditEvents.value = []
  } finally {
    loadingAudit.value = false
  }
}

async function refresh() {
  loading.value = true
  clearFlags()
  try {
    job.value = await getJob(jobId.value)
    const [specHistory, jdHistory, departmentRows] = await Promise.all([
      listJobSpecVersions(jobId.value),
      listJobDescriptionVersions(jobId.value),
      loadDepartments().catch(() => []),
    ])
    specVersions.value = specHistory
    jdVersions.value = jdHistory
    departments.value = departmentRows
    specConfirmed.value = Boolean(job.value?.spec?.confirmed)
    jdConfirmed.value = Boolean(job.value?.jd?.confirmed)
    resetSpecForm()
    resetJdForm()
    await loadAuditEvents(jobId.value)
    if (approvedRequestId.value && !requestTitle.value) {
      try {
        const req = await apiClient.getJson<any>(`/recruitment-requests/${approvedRequestId.value}`)
        requestApproved.value = req.data?.status === 'approved'
        requestTitle.value = req.data?.title || ''
      } catch {
        requestApproved.value = false
      }
    }
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取岗位失败').message
  } finally {
    loading.value = false
  }
}

function openEditForm() {
  if (!job.value) return
  if (job.value.departmentId && !departments.value.some((item) => item.code === job.value?.departmentId)) {
    departments.value.push({ id: `legacy-${job.value.departmentId}`, code: job.value.departmentId, name: job.value.department || job.value.departmentId, isActive: false })
  }
  editForm.value = {
    title: job.value.title,
    departmentId: job.value.departmentId,
    hiringManagerId: job.value.hiringManagerId || '',
    employmentType: job.value.employmentType,
    workMode: job.value.workMode,
    location: job.value.location || '',
    headcount: job.value.headcount,
  }
  editError.value = ''
  showEdit.value = true
}

async function submitEdit() {
  if (acting.value || !job.value) return
  const payload: UpdateJobInput = {}
  for (const field of editableFields.value) {
    if (field === 'headcount') {
      payload.headcount = Number(editForm.value.headcount)
    } else if (field === 'title' || field === 'departmentId' || field === 'employmentType' || field === 'workMode' || field === 'location') {
      ;(payload as Record<string, unknown>)[field] = (editForm.value as Record<string, unknown>)[field]
    }
  }
  const validation = validateJobForm({ ...payload, title: editForm.value.title, departmentId: editForm.value.departmentId, employmentType: editForm.value.employmentType, workMode: editForm.value.workMode, headcount: editForm.value.headcount })
  if (validation) {
    editError.value = validation
    return
  }
  acting.value = true
  clearFlags()
  try {
    job.value = await updateJob(job.value.id, payload)
    feedback.value = '岗位基础信息已更新'
    showEdit.value = false
  } catch (cause) {
    editError.value = describeApiFailure(cause, '更新岗位失败').message
  } finally {
    acting.value = false
  }
}

async function generateSpec() {
  if (acting.value || !job.value) return
  acting.value = true
  clearFlags()
  try {
    job.value = await generateJobSpec(job.value.id)
    specVersions.value = await listJobSpecVersions(job.value.id)
    specConfirmed.value = Boolean(job.value.spec?.confirmed)
    editingSpec.value = false
    resetSpecForm()
    feedback.value = job.value.spec?.generatedBy === 'local_fallback'
      ? '未配置 AI 大模型，已使用本地模板生成岗位说明书（未确认）'
      : 'AI 已根据岗位名称生成岗位说明书（未确认）'
  } catch (cause) {
    error.value = describeApiFailure(cause, '生成岗位说明书失败').message
  } finally {
    acting.value = false
  }
}

async function generateJd() {
  if (acting.value || !job.value) return
  acting.value = true
  clearFlags()
  try {
    job.value = await generateJobDescription(job.value.id)
    jdVersions.value = await listJobDescriptionVersions(job.value.id)
    jdConfirmed.value = Boolean(job.value.jd?.confirmed)
    editingJd.value = false
    resetJdForm()
    feedback.value = job.value.jd?.generatedBy === 'local_fallback'
      ? '未配置 AI 大模型，已使用本地模板生成 JD（未确认）'
      : 'AI 已根据岗位生成 JD（未确认）'
  } catch (cause) {
    error.value = describeApiFailure(cause, '生成 JD 失败').message
  } finally {
    acting.value = false
  }
}

function openSpecEditor() {
  resetSpecForm()
  editingSpec.value = true
}

function openJdEditor() {
  resetJdForm()
  editingJd.value = true
}

async function saveSpec() {
  if (acting.value || !job.value) return
  if (!specForm.value.title.trim() || !specForm.value.summary.trim()) {
    error.value = '请填写说明书标题和摘要'
    return
  }
  acting.value = true
  clearFlags()
  try {
    job.value = await createSpec(job.value.id, {
      title: specForm.value.title.trim(),
      summary: specForm.value.summary.trim(),
      responsibilities: splitList(specForm.value.responsibilitiesText),
      requirements: parseRequirements(specForm.value.requirementsText),
      skills: splitList(specForm.value.skillsText),
    })
    specVersions.value = await listJobSpecVersions(job.value.id)
    specConfirmed.value = false
    editingSpec.value = false
    feedback.value = '岗位说明书已保存为新版本（未确认）'
  } catch (cause) {
    error.value = describeApiFailure(cause, '保存岗位说明书失败').message
  } finally {
    acting.value = false
  }
}

async function saveJd() {
  if (acting.value || !job.value) return
  if (!jdForm.value.content.trim()) {
    error.value = 'JD 内容不能为空'
    return
  }
  acting.value = true
  clearFlags()
  try {
    job.value = await createJd(job.value.id, { language: jdForm.value.language, content: jdForm.value.content.trim(), generatedBy: 'human' })
    jdVersions.value = await listJobDescriptionVersions(job.value.id)
    jdConfirmed.value = false
    editingJd.value = false
    feedback.value = 'JD 已保存为新版本（未确认）'
  } catch (cause) {
    error.value = describeApiFailure(cause, '保存 JD 失败').message
  } finally {
    acting.value = false
  }
}

function confirm(action: JobAction) {
  if (!job.value) return
  if (JOB_REASON_REQUIRED.includes(action)) {
    reason.value = ''
    pendingAction.value = action
    return
  }
  void runAction(action)
}

async function runAction(action: JobAction) {
  if (acting.value || !job.value) return
  const value = reason.value.trim()
  if (JOB_REASON_REQUIRED.includes(action) && !value) return
  pendingAction.value = null
  acting.value = true
  clearFlags()
  try {
    job.value = await jobAction(job.value.id, action, value || undefined)
    specConfirmed.value = Boolean(job.value.spec?.confirmed)
    jdConfirmed.value = Boolean(job.value.jd?.confirmed)
    feedback.value = `${JOB_ACTION_LABEL[action]}成功，当前状态 ${jobStatusLabel(job.value.status)}`
  } catch (cause) {
    error.value = describeApiFailure(cause, '岗位操作失败').message
  } finally {
    acting.value = false
  }
}

function submitPending() { if (pendingAction.value) void runAction(pendingAction.value) }

function requirementText(item: JobRequirement): string {
  const parts = [item.label, item.description].filter(Boolean)
  return parts.join('：')
}

function jdSourceLabel(generatedBy: string): string {
  if (generatedBy === 'local_fallback') return '本地生成'
  if (generatedBy === 'ai_assisted') return 'AI 辅助'
  return '人工'
}

async function applyDocQuery() {
  const doc = route.query.doc
  if (doc !== 'spec' && doc !== 'jd') return
  await nextTick()
  document.getElementById(`job-document-${doc}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

onMounted(async () => {
  await refresh()
  await applyDocQuery()
})
</script>

<template>
  <PageHeader title="岗位详情" :description="job?.title || ''">
    <div class="inline-actions">
      <button class="btn btn-ghost" type="button" @click="router.back">返回列表</button>
      <button class="btn btn-ghost" type="button" @click="refresh">刷新</button>
      <button v-if="job" class="btn btn-primary" type="button" :disabled="acting" @click="openEditForm">编辑基础信息</button>
    </div>
  </PageHeader>

  <PageFeedback :feedback="feedback" :error="error" @clear-feedback="feedback = ''" @clear-error="error = ''" />
  <div v-if="loading" class="loading-note">正在读取岗位...</div>

  <section v-else-if="job" class="form-panel">
    <div class="section-title">基础信息</div>
    <div class="detail-grid">
      <div class="detail-item"><span>部门</span><strong>{{ job.department }}</strong></div>
      <div class="detail-item"><span>状态</span><StatusTag :status="job.status" /></div>
      <div class="detail-item"><span>招聘人数</span><strong>{{ job.headcount }} / 已入职 {{ job.filledCount }}</strong></div>
      <div class="detail-item"><span>用工类型</span><strong>{{ employmentTypeLabel(job.employmentType) }}</strong></div>
      <div class="detail-item"><span>工作模式</span><strong>{{ workModeLabel(job.workMode) }}</strong></div>
      <div class="detail-item"><span>需求来源</span><strong>{{ requestTitle || '—' }}</strong></div>
      <div class="detail-item"><span>发布渠道</span><strong>{{ job.channels.length ? job.channels.join('、') : '未发布' }}</strong></div>
      <div class="detail-item"><span>更新日期</span><strong>{{ job.updatedAt.slice(0, 10) }}</strong></div>
    </div>

    <div class="section-title" style="margin-top:18px">岗位文档</div>
    <div class="document-grid">
      <article id="job-document-spec" class="document-card">
        <header>
          <div><strong>岗位说明书</strong><span v-if="job.spec" class="list-muted">v{{ job.spec.version }} · {{ job.spec.generatedBy === 'local_fallback' ? '本地生成' : 'AI 生成' }} · {{ job.spec.confirmed ? '已确认' : '未确认' }}</span><span v-else class="list-muted">未创建</span></div>
          <div class="inline-actions">
            <template v-if="editingSpec">
              <button class="btn btn-primary" type="button" :disabled="acting" @click="saveSpec">{{ acting ? '保存中...' : '保存' }}</button>
              <button class="btn btn-ghost" type="button" :disabled="acting" @click="editingSpec = false">取消</button>
            </template>
            <template v-else>
              <button class="btn btn-ghost" type="button" :disabled="acting" @click="generateSpec">{{ acting ? '生成中...' : (job.spec ? 'AI 重新生成' : 'AI 生成') }}</button>
              <button class="btn btn-ghost" type="button" :disabled="acting" @click="openSpecEditor">{{ job.spec ? '编辑' : '手动填写' }}</button>
              <button v-if="job.spec && !job.spec.confirmed" class="btn btn-primary" type="button" :disabled="acting" @click="confirm('confirm-spec')">确认</button>
            </template>
          </div>
        </header>
        <template v-if="editingSpec">
          <label>标题<input v-model="specForm.title" /></label>
          <label>摘要<textarea v-model="specForm.summary" rows="2"></textarea></label>
          <label>职责（每行一条）<textarea v-model="specForm.responsibilitiesText" rows="3"></textarea></label>
          <label>要求（每行一条，可写“名称：描述”）<textarea v-model="specForm.requirementsText" rows="3"></textarea></label>
          <label>技能（逗号分隔）<input v-model="specForm.skillsText" /></label>
        </template>
        <template v-else-if="job.spec">
          <p>{{ job.spec.summary }}</p>
          <div class="document-block"><span>职责</span><ul><li v-for="(item, index) in job.spec.responsibilities" :key="index">{{ item }}</li></ul></div>
          <div class="document-block"><span>要求</span><ul><li v-for="(item, index) in job.spec.requirements" :key="index">{{ requirementText(item) }}</li></ul></div>
          <div class="document-block"><span>技能</span><p>{{ job.spec.skills.join('、') || '—' }}</p></div>
        </template>
        <p v-else class="hint">尚未生成岗位说明书。</p>
      </article>

      <article id="job-document-jd" class="document-card">
        <header>
          <div><strong>JD</strong><span v-if="job.jd" class="list-muted">v{{ job.jd.version }} · {{ jdSourceLabel(job.jd.generatedBy) }} · {{ job.jd.confirmed ? '已确认' : '未确认' }}</span><span v-else class="list-muted">未创建</span></div>
          <div class="inline-actions">
            <template v-if="editingJd">
              <button class="btn btn-primary" type="button" :disabled="acting" @click="saveJd">{{ acting ? '保存中...' : '保存' }}</button>
              <button class="btn btn-ghost" type="button" :disabled="acting" @click="editingJd = false">取消</button>
            </template>
            <template v-else>
              <button class="btn btn-ghost" type="button" :disabled="acting" @click="generateJd">{{ acting ? '生成中...' : (job.jd ? 'AI 重新生成' : 'AI 生成') }}</button>
              <button class="btn btn-ghost" type="button" :disabled="acting" @click="openJdEditor">{{ job.jd ? '编辑' : '手动填写' }}</button>
              <button v-if="job.jd && !job.jd.confirmed" class="btn btn-primary" type="button" :disabled="acting" @click="confirm('confirm-jd')">确认</button>
            </template>
          </div>
        </header>
        <textarea v-if="editingJd" v-model="jdForm.content" rows="12"></textarea>
        <pre v-else-if="job.jd">{{ job.jd.content }}</pre>
        <p v-else class="hint">尚未生成 JD。</p>
      </article>
    </div>

    <div class="section-title" style="margin-top:18px">可执行动作</div>
    <div class="actions-panel">
      <button
        v-for="action in actions"
        :key="action"
        type="button"
        class="btn"
        :class="action === 'publish' ? 'btn-primary' : 'btn-ghost'"
        :disabled="acting || (action === 'publish' && publishDisabled)"
        @click="confirm(action)"
      >
        {{ acting ? '处理中...' : JOB_ACTION_LABEL[action] }}
      </button>
      <span v-if="!actions.length" class="hint">当前状态无可执行动作</span>
      <span class="hint">{{ publishHint || `当前状态：${JOB_STATUS_LABEL[job.status] ?? job.status}` }}</span>
    </div>

    <div class="details-stack">
      <details v-if="specVersions.length">
        <summary>说明书版本历史（{{ specVersions.length }}）</summary>
        <table class="detail-table">
          <thead><tr><th>版本</th><th>标题</th><th>状态</th><th>创建时间</th></tr></thead>
          <tbody><tr v-for="item in specVersions" :key="item.jobId + '-spec-' + item.version"><td>v{{ item.version }}</td><td>{{ item.title }}</td><td>{{ item.confirmed ? '已确认' : '未确认' }}</td><td>{{ (item.createdAt || '').slice(0, 19).replace('T', ' ') }}</td></tr></tbody>
        </table>
      </details>
      <details v-if="jdVersions.length">
        <summary>JD 版本历史（{{ jdVersions.length }}）</summary>
        <table class="detail-table">
          <thead><tr><th>版本</th><th>生成方式</th><th>状态</th><th>创建时间</th></tr></thead>
          <tbody><tr v-for="item in jdVersions" :key="item.jobId + '-jd-' + item.version"><td>v{{ item.version }}</td><td>{{ jdSourceLabel(item.generatedBy) }}</td><td>{{ item.confirmed ? '已确认' : '未确认' }}</td><td>{{ (item.createdAt || '').slice(0, 19).replace('T', ' ') }}</td></tr></tbody>
        </table>
      </details>
      <details>
        <summary>流程审计（{{ auditEvents.length }}）</summary>
        <div v-if="loadingAudit" class="loading-note">正在读取审计记录...</div>
        <p v-else-if="!auditEvents.length" class="hint">暂无流程审计记录</p>
        <table v-else class="detail-table">
          <thead><tr><th>时间</th><th>动作</th><th>状态流转</th><th>操作人</th><th>原因</th></tr></thead>
          <tbody><tr v-for="event in auditEvents" :key="event.id"><td>{{ (event.createdAt || '').slice(0, 19).replace('T', ' ') }}</td><td>{{ actionLabel(event.action) }}</td><td>{{ statusLabel(event.fromStatus) }} → {{ statusLabel(event.toStatus) }}</td><td>{{ event.actorName || '系统' }}</td><td>{{ event.reason || '-' }}</td></tr></tbody>
        </table>
      </details>
    </div>
  </section>

  <section v-if="showEdit && job" class="form-panel">
    <div class="section-title">编辑基础信息</div>
    <div v-if="editError" class="error-note">{{ editError }}</div>
    <div class="form-grid">
      <div class="form-field"><label>岗位名称 <span class="required">*</span></label><input v-model="editForm.title" /></div>
      <div class="form-field"><label>部门 <span class="required">*</span></label><select v-model="editForm.departmentId"><option value="" disabled>请选择部门</option><option v-for="department in departments" :key="department.id" :value="department.code" :disabled="!department.isActive">{{ department.name }}{{ department.isActive ? '' : '（已停用，仅保留历史）' }}</option></select></div>
      <div class="form-field"><label>招聘人数 <span class="required">*</span></label><input v-model.number="editForm.headcount" type="number" min="1" /></div>
      <div class="form-field"><label>用工类型 <span class="required">*</span></label><select v-model="editForm.employmentType"><option value="full_time">全职</option><option value="part_time">兼职</option><option value="internship">实习</option></select></div>
      <div class="form-field"><label>工作模式 <span class="required">*</span></label><select v-model="editForm.workMode"><option value="hybrid">混合办公</option><option value="onsite">现场办公</option><option value="remote">远程</option></select></div>
      <div class="form-field"><label>工作地点</label><input v-model="editForm.location" /></div>
      <div class="form-field"><label>负责人</label><input v-model="editForm.hiringManagerId" /></div>
    </div>
    <div class="inline-actions" style="margin-top:14px">
      <button class="btn btn-primary" type="button" :disabled="acting" @click="submitEdit">{{ acting ? '保存中...' : '保存' }}</button>
      <button class="btn btn-ghost" type="button" :disabled="acting" @click="showEdit = false">取消</button>
    </div>
  </section>

  <div v-if="pendingAction" class="overlay" role="presentation" @click.self="pendingAction = null">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>{{ JOB_ACTION_LABEL[pendingAction] }}</h3>
      <p>岗位 {{ job?.title }}</p>
      <div class="form-field">
        <label for="job-reason">操作原因（必填）</label>
        <textarea id="job-reason" v-model="reason" rows="3" placeholder="请填写操作原因"></textarea>
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" @click="pendingAction = null">取消</button>
        <button class="btn btn-primary" type="button" :disabled="!reason.trim()" @click="submitPending">确认</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
p { margin: 8px 0; }
ul { margin: 8px 0 0; padding-left: 20px; }
.document-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.document-card { border: 1px solid var(--border); background: #fff; padding: 16px; min-width: 0; }
.document-card header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.document-card header strong { display: block; margin-bottom: 4px; }
.document-card header span { display: block; }
.document-card label { display: grid; gap: 6px; margin-bottom: 10px; font-size: 13px; color: var(--text-muted); }
.document-card input, .document-card textarea { width: 100%; }
.document-card > pre { margin: 0; white-space: pre-wrap; font-family: inherit; line-height: 1.7; }
.document-block { margin-top: 14px; }
.document-block > span { display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted); }
.details-stack { display: grid; gap: 10px; margin-top: 18px; }
.details-stack details { border: 1px solid var(--border); background: #fff; padding: 12px 14px; }
.details-stack summary { cursor: pointer; font-weight: 600; }
.details-stack .detail-table { margin-top: 12px; }
.detail-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
.detail-table th, .detail-table td { border: 1px solid #e5e7eb; padding: 8px 10px; text-align: left; vertical-align: top; font-size: 13px; }
.detail-table th { background: #f9fafb; }
.detail-table pre { margin: 0; white-space: pre-wrap; font-family: inherit; }
@media (max-width: 900px) {
  .document-grid { grid-template-columns: 1fr; }
  .document-card header { flex-direction: column; }
}
</style>
