<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiClient } from '../../../shared/api'
import { createJob, createJd, createSpec, getJob, jobAction, listJobDescriptionVersions, listJobSpecVersions, loadJobs, updateJob, type ApiJob, type ApiJobJdVersion, type ApiJobSpecVersion, type CreateSpecInput, type JobAction, type JobRequirement, type JobView, type UpdateJobInput } from '../api'
import { JOB_ACTION_HINT, JOB_ACTION_LABEL, JOB_REASON_REQUIRED, JOB_STATUS_LABEL, editableFieldsForStatus, jobActionsFor, jobPublishHint, jobStatusLabel, validateJobForm } from '../workflow'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
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

const showSpec = ref(false)
const showJd = ref(false)
const showEdit = ref(false)
const specForm = ref({ title: '', summary: '', responsibilitiesText: '', skillsText: '', requirements: [] as JobRequirement[] })
const jdForm = ref({ language: 'zh-CN', content: '', generatedBy: 'human' as 'human' | 'ai_assisted' })
const editForm = ref({ title: '', departmentId: '', hiringManagerId: '', employmentType: 'full_time', workMode: 'hybrid', location: '', headcount: 1 })
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
const publishNote = computed(() => {
  if (!approvedRequestId.value) return '缺少关联需求或请求状态异常。'
  if (!requestApproved.value) return '关联需求未处于已通过状态，不能发布。'
  if (!specConfirmed.value) return '岗位说明书尚未确认。'
  if (!jdConfirmed.value) return 'JD 尚未确认。'
  return ''
})
const actionHint = computed(() => (pendingAction.value ? JOB_ACTION_HINT[pendingAction.value] : ''))
const editableFields = computed(() => (job.value ? editableFieldsForStatus(job.value.status) : []))

function clearFlags() { error.value = ''; feedback.value = ''; editError.value = '' }

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

function resetSpecForm() {
  const spec = job.value?.spec
  specForm.value = {
    title: spec?.title || job.value?.title || '',
    summary: spec?.summary || '',
    responsibilitiesText: (spec?.responsibilities || []).join('，'),
    skillsText: (spec?.skills || []).join('，'),
    requirements: (spec?.requirements || []).map((item) => ({ label: item.label, description: item.description, required: item.required ?? true, weight: item.weight })),
  }
  if (!specForm.value.requirements.length) specForm.value.requirements.push({ label: '', description: '', required: true })
}

function addRequirement() { specForm.value.requirements.push({ label: '', description: '', required: true }) }
function removeRequirement(index: number) { specForm.value.requirements.splice(index, 1) }

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

async function submitSpec() {
  if (acting.value || !job.value) return
  if (!specForm.value.title.trim() || !specForm.value.summary.trim()) {
    error.value = '请填写说明书标题与摘要'
    return
  }
  const payload: CreateSpecInput = {
    title: specForm.value.title.trim(),
    summary: specForm.value.summary.trim(),
    responsibilities: splitList(specForm.value.responsibilitiesText),
    requirements: specForm.value.requirements.filter((item) => item.label.trim()),
    skills: splitList(specForm.value.skillsText),
  }
  acting.value = true
  clearFlags()
  try {
    job.value = await createSpec(job.value.id, payload)
    specVersions.value = await listJobSpecVersions(job.value.id)
    specConfirmed.value = Boolean(job.value.spec?.confirmed)
    feedback.value = '岗位说明书已创建（未确认）'
    showSpec.value = false
  } catch (cause) {
    error.value = describeApiFailure(cause, '创建岗位说明书失败').message
  } finally {
    acting.value = false
  }
}

async function submitJd() {
  if (acting.value || !job.value) return
  if (!jdForm.value.content.trim()) {
    error.value = '请填写 JD 内容'
    return
  }
  acting.value = true
  clearFlags()
  try {
    job.value = await createJd(job.value.id, { language: jdForm.value.language, content: jdForm.value.content.trim(), generatedBy: jdForm.value.generatedBy })
    jdVersions.value = await listJobDescriptionVersions(job.value.id)
    jdConfirmed.value = Boolean(job.value.jd?.confirmed)
    feedback.value = 'JD 已创建（未确认）'
    showJd.value = false
  } catch (cause) {
    error.value = describeApiFailure(cause, '创建 JD 失败').message
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

function splitList(text: string): string[] {
  return text.split(/[，,、]/).map((item) => item.trim()).filter(Boolean)
}

function requirementText(item: JobRequirement): string {
  const parts = [item.label, item.description].filter(Boolean)
  return parts.join('：')
}

function openSpecForm() {
  resetSpecForm()
  showSpec.value = true
}

function openJdForm() {
  showJd.value = true
}

function applyDocQuery() {
  const doc = route.query.doc
  if (doc === 'spec') openSpecForm()
  else if (doc === 'jd') openJdForm()
}

onMounted(async () => {
  await refresh()
  applyDocQuery()
})
</script>

<template>
  <PageHeader title="岗位详情" :description="job ? `${job.title}（${job.code || job.id}）` : ''">
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
      <div class="detail-item"><span>岗位编号</span><strong>{{ job.code || job.id }}</strong></div>
      <div class="detail-item"><span>部门</span><strong>{{ job.department }}</strong></div>
      <div class="detail-item"><span>状态</span><StatusTag :status="job.status" /></div>
      <div class="detail-item"><span>招聘人数</span><strong>{{ job.headcount }} / 已入职 {{ job.filledCount }}</strong></div>
      <div class="detail-item"><span>用工类型</span><strong>{{ job.employmentType }}</strong></div>
      <div class="detail-item"><span>工作模式</span><strong>{{ job.workMode }}</strong></div>
      <div class="detail-item"><span>需求来源</span><strong>{{ requestTitle || job.recruitmentRequestId || '—' }}</strong></div>
      <div class="detail-item"><span>发布渠道</span><strong>{{ job.channels.length ? job.channels.join('、') : '未发布' }}</strong></div>
      <div class="detail-item"><span>更新日期</span><strong>{{ job.updatedAt.slice(0, 10) }}</strong></div>
    </div>

    <div class="section-title" style="margin-top:18px">发布前检查</div>
    <div class="detail-card">
      <div class="detail-grid">
        <div class="detail-item"><span>关联需求</span><strong>{{ approvedRequestId || '未设置' }}</strong></div>
        <div class="detail-item"><span>需求审批状态</span><StatusTag :status="requestApproved ? 'approved' : 'pending_approval'" /></div>
        <div class="detail-item"><span>说明书确认</span><StatusTag :status="specConfirmed ? 'approved' : 'pending'" /></div>
        <div class="detail-item"><span>JD 确认</span><StatusTag :status="jdConfirmed ? 'approved' : 'pending'" /></div>
        <div class="detail-item" style="grid-column:1 / -1"><span>发布提示</span><strong>{{ publishNote || '需求审批、说明书和 JD 已就绪，可尝试发布。' }}</strong></div>
      </div>
    </div>

    <div v-if="!job.spec || !job.jd" class="doc-empty">
      <div class="doc-empty-inner">
        <span class="doc-empty-title">岗位文档待完善</span>
        <div class="inline-actions">
          <div v-if="!job.spec" class="doc-empty-item">
            <span>尚未创建岗位说明书</span>
            <button class="btn btn-primary" type="button" :disabled="acting" @click="openSpecForm()">新建说明书</button>
          </div>
          <div v-if="!job.jd" class="doc-empty-item">
            <span>尚未创建 JD</span>
            <button class="btn btn-primary" type="button" :disabled="acting" @click="openJdForm()">新建 JD</button>
          </div>
        </div>
      </div>
    </div>

    <div class="section-title" style="margin-top:18px">岗位说明书</div>
    <div v-if="job.spec" class="detail-card">
      <div class="detail-meta">
        <span class="list-muted">版本 {{ job.spec.version }} · {{ job.spec.confirmed ? '已确认' : '未确认' }}</span>
        <button v-if="!job.spec.confirmed" class="btn btn-primary" type="button" :disabled="acting" @click="confirm('confirm-spec')">确认说明书</button>
      </div>
      <strong>{{ job.spec.title }}</strong>
      <p class="list-muted">{{ job.spec.summary }}</p>
      <p class="list-muted">职责：{{ (job.spec.responsibilities || []).join('、') || '—' }}</p>
      <p class="list-muted">技能：{{ (job.spec.skills || []).join('、') || '—' }}</p>
      <ul v-if="job.spec.requirements.length">
        <li v-for="(item, index) in job.spec.requirements" :key="index">{{ requirementText(item) }}<span v-if="item.required" class="list-muted">（必填）</span></li>
      </ul>
    </div>
    <div v-else class="empty-note">
      <span>暂无岗位说明书</span>
      <button class="btn btn-primary" type="button" :disabled="acting" @click="openSpecForm()">新建说明书</button>
    </div>

    <div class="section-title" style="margin-top:18px">JD</div>
    <div v-if="job.jd" class="detail-card">
      <div class="detail-meta">
        <span class="list-muted">版本 {{ job.jd.version }} · {{ job.jd.language }} · {{ job.jd.generatedBy === 'ai_assisted' ? 'AI 辅助' : '人工' }} · {{ job.jd.confirmed ? '已确认' : '未确认' }}</span>
        <button v-if="!job.jd.confirmed" class="btn btn-primary" type="button" :disabled="acting" @click="confirm('confirm-jd')">确认 JD</button>
      </div>
      <p style="white-space:pre-wrap">{{ job.jd.content }}</p>
    </div>
    <div v-else class="empty-note">
      <span>暂无 JD</span>
      <button class="btn btn-primary" type="button" :disabled="acting" @click="openJdForm()">新建 JD</button>
    </div>

    <div v-if="specVersions.length" class="section-title" style="margin-top:18px">说明书版本历史</div>
    <div v-if="specVersions.length" class="detail-card">
      <table class="detail-table">
        <thead><tr><th>版本</th><th>标题</th><th>状态</th><th>创建时间</th></tr></thead>
        <tbody>
          <tr v-for="item in specVersions" :key="item.jobId + '-spec-' + item.version">
            <td>v{{ item.version }}</td>
            <td>{{ item.title }}</td>
            <td>{{ item.confirmed ? '已确认' : '未确认' }}</td>
            <td>{{ (item.createdAt || '').slice(0, 19).replace('T', ' ') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="jdVersions.length" class="section-title" style="margin-top:18px">JD 版本历史</div>
    <div v-if="jdVersions.length" class="detail-card">
      <table class="detail-table">
        <thead><tr><th>版本</th><th>语言</th><th>生成方式</th><th>状态</th><th>创建时间</th><th>内容</th></tr></thead>
        <tbody>
          <tr v-for="item in jdVersions" :key="item.jobId + '-jd-' + item.version">
            <td>v{{ item.version }}</td>
            <td>{{ item.language }}</td>
            <td>{{ item.generatedBy === 'ai_assisted' ? 'AI 辅助' : '人工' }}</td>
            <td>{{ item.confirmed ? '已确认' : '未确认' }}</td>
            <td>{{ (item.createdAt || '').slice(0, 19).replace('T', ' ') }}</td>
            <td><pre>{{ item.content }}</pre></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="section-title" style="margin-top:18px">流程审计</div>
    <div v-if="loadingAudit" class="loading-note">正在读取审计记录...</div>
    <div v-else-if="!auditEvents.length" class="hint">暂无流程审计记录</div>
    <div v-else class="detail-card">
      <table class="detail-table">
        <thead><tr><th>时间</th><th>动作</th><th>状态流转</th><th>操作人</th><th>原因</th></tr></thead>
        <tbody>
          <tr v-for="event in auditEvents" :key="event.id">
            <td>{{ (event.createdAt || '').slice(0, 19).replace('T', ' ') }}</td>
            <td>{{ event.action }}</td>
            <td>{{ event.fromStatus || '-' }} → {{ event.toStatus || '-' }}</td>
            <td>{{ event.actorName || event.actorId || '系统' }}</td>
            <td>{{ event.reason || '-' }}</td>
          </tr>
        </tbody>
      </table>
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
  </section>

  <section v-if="showSpec" class="form-panel">
    <div class="section-title">新建岗位说明书</div>
    <div class="form-grid">
      <div class="form-field"><label>标题</label><input v-model="specForm.title" /></div>
      <div class="form-field"><label>摘要</label><input v-model="specForm.summary" /></div>
      <div class="form-field"><label>职责（逗号分隔）</label><input v-model="specForm.responsibilitiesText" /></div>
      <div class="form-field"><label>技能（逗号分隔）</label><input v-model="specForm.skillsText" /></div>
      <div class="form-field" style="grid-column: 1 / -1">
        <label>要求</label>
        <div v-for="(item, index) in specForm.requirements" :key="index" class="requirement-row">
          <input v-model="item.label" placeholder="名称，例如：本科及以上学历" />
          <input v-model="item.description" placeholder="描述，例如：计算机相关专业" />
          <label><input type="checkbox" v-model="item.required" /> 必填</label>
          <button class="btn btn-ghost" type="button" @click="removeRequirement(index)">删除</button>
        </div>
        <button class="btn btn-ghost" type="button" @click="addRequirement">添加要求</button>
      </div>
    </div>
    <div class="inline-actions" style="margin-top:14px">
      <button class="btn btn-primary" type="button" :disabled="acting" @click="submitSpec">{{ acting ? '保存中...' : '保存说明书' }}</button>
      <button class="btn btn-ghost" type="button" :disabled="acting" @click="showSpec = false">取消</button>
    </div>
  </section>

  <section v-if="showJd" class="form-panel">
    <div class="section-title">新建 JD</div>
    <div class="form-grid">
      <div class="form-field"><label>语言</label><select v-model="jdForm.language"><option value="zh-CN">中文</option><option value="en">英文</option></select></div>
      <div class="form-field"><label>生成方式</label><select v-model="jdForm.generatedBy"><option value="human">人工</option><option value="ai_assisted">AI 辅助</option></select></div>
      <div class="form-field" style="grid-column: 1 / -1"><label>内容</label><textarea v-model="jdForm.content" rows="5" placeholder="请输入岗位描述"></textarea></div>
    </div>
    <div class="inline-actions" style="margin-top:14px">
      <button class="btn btn-primary" type="button" :disabled="acting" @click="submitJd">{{ acting ? '保存中...' : '保存 JD' }}</button>
      <button class="btn btn-ghost" type="button" :disabled="acting" @click="showJd = false">取消</button>
    </div>
  </section>

  <section v-if="showEdit && job" class="form-panel">
    <div class="section-title">编辑基础信息</div>
    <div v-if="editError" class="error-note">{{ editError }}</div>
    <div class="form-grid">
      <div class="form-field"><label>岗位名称 <span class="required">*</span></label><input v-model="editForm.title" /></div>
      <div class="form-field"><label>部门 <span class="required">*</span></label><select v-model="editForm.departmentId"><option value="" disabled>请选择部门</option><option v-for="department in departments" :key="department.id" :value="department.code" :disabled="!department.isActive">{{ department.name }}（{{ department.code }}）{{ department.isActive ? '' : '（已停用，仅保留历史）' }}</option></select></div>
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
.doc-empty {
  margin: 14px 0;
  padding: 14px;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  border-left: 3px solid #f97316;
  border-radius: var(--radius);
}
.doc-empty-inner {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.doc-empty-title {
  font-weight: 700;
  color: #9a3412;
}
.doc-empty-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #7c2d12;
  font-size: 12.5px;
}
.detail-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
.detail-table th, .detail-table td { border: 1px solid #e5e7eb; padding: 8px 10px; text-align: left; vertical-align: top; font-size: 13px; }
.detail-table th { background: #f9fafb; }
.detail-table pre { margin: 0; white-space: pre-wrap; font-family: inherit; }
</style>
