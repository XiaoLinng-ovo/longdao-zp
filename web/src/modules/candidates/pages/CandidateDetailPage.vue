<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  createApplication,
  getAnalysisResult,
  getCandidate,
  loadCandidateTags,
  loadJobs,
  processAnalysisTask,
  reviewAnalysisResult,
  updateApplicationStatus,
  updateCandidate,
  uploadResume,
} from '../api'
import type { ApiAnalysisResult, ApiApplication, ApiCandidateDetail, CandidateStatus } from '../api'
import { humanReviewStatusLabel, recommendationLabel } from '../labels'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { isApiClientError } from '../../../shared/api'
import { loadWorkflowEvents, type WorkflowEvent } from '../../../shared/api/workflow-events'
import PageHeader from '../../../shared/components/PageHeader.vue'
import PageFeedback from '../../../shared/components/workflow/PageFeedback.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import WorkflowEventTable from '../../../shared/components/workflow/WorkflowEventTable.vue'

const route = useRoute()
const router = useRouter()

const id = computed(() => String(route.params.id || ''))
const detail = ref<ApiCandidateDetail | null>(null)
const allTags = ref<string[]>([])
const showTagEditor = ref(false)
const tagDraft = ref('')
const savingTags = ref(false)
const loading = ref(true)
const error = ref('')
const feedback = ref('')
const actingId = ref('')

const pending = ref<{ applicationId: string; status: 'rejected' | 'withdrawn' } | null>(null)
const reason = ref('')
const auditEvents = ref<WorkflowEvent[]>([])
const loadingAudit = ref(false)

const CANDIDATE_STATUS_LABEL: Record<CandidateStatus, string> = {
  active: '有效',
  archived: '已归档',
  do_not_contact: '请勿联系',
}

const APP_STATUS_LABEL: Record<string, string> = {
  new: '新申请', screening: '筛选中', interview: '面试中', offer: '已发 Offer', hired: '已入职', rejected: '已淘汰', withdrawn: '已撤回',
}

const ADVANCE: Record<string, { next: string; label: string } | undefined> = {
  new: { next: 'screening', label: '开始筛选' },
  screening: { next: 'interview', label: '转面试' },
  interview: { next: 'offer', label: '发 Offer' },
  offer: { next: 'hired', label: '确认入职' },
}

const jobMap = computed(() => new Map((detail.value?.jobs ?? []).map((job) => [job.id, job])))

function jobTitle(application: ApiApplication): string {
  const job = jobMap.value.get(application.jobId)
  return job ? `${job.title}（${job.code || job.id}）` : application.jobId
}

function analysisTaskStatusLabel(status: string): string {
  return ({ queued: '排队中', processing: '处理中', completed: '已完成', failed: '失败' } as Record<string, string>)[status] ?? status
}

function clearFlags() { error.value = ''; feedback.value = '' }

async function loadTags() {
  try {
    allTags.value = await loadCandidateTags()
    const current = new Set(detail.value?.tags ?? [])
    for (const tag of allTags.value) current.add(tag)
    allTags.value = [...current]
  } catch {
    allTags.value = detail.value?.tags ?? []
  }
}

function openTagEditor() {
  clearFlags()
  tagDraft.value = (detail.value?.tags ?? []).join('，')
  showTagEditor.value = true
}

async function saveTags() {
  if (savingTags.value || !detail.value) return
  const tags = tagDraft.value.split(/[，,、\s]+/).map((tag) => tag.trim()).filter(Boolean)
  savingTags.value = true
  clearFlags()
  try {
    const updated = await updateCandidate(detail.value.id, { tags })
    if (detail.value) detail.value.tags = updated.tags ?? []
    showTagEditor.value = false
    feedback.value = '标签已保存'
    await loadTags()
  } catch (cause) {
    error.value = describeApiFailure(cause, '标签保存失败').message
  } finally {
    savingTags.value = false
  }
}

async function loadAuditEvents(candidateId: string) {
  loadingAudit.value = true
  auditEvents.value = []
  try {
    const relatedIds = new Set<string>([candidateId])
    for (const application of detail.value?.applications ?? []) relatedIds.add(application.id)
    auditEvents.value = await loadWorkflowEvents(undefined, 300).then((rows) => rows.filter((event) => relatedIds.has(event.subjectId)))
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
    detail.value = await getCandidate(id.value)
    await Promise.all([loadTags(), loadAuditEvents(detail.value.id)])
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取候选人失败').message
  } finally {
    loading.value = false
  }
}

function canOperate(status: string): boolean {
  return ['new', 'screening', 'interview', 'offer'].includes(status)
}

async function advance(application: ApiApplication) {
  if (actingId.value) return
  const step = ADVANCE[application.status]
  if (!step) return
  await runStatus(application, step.next as ApiApplication['status'], undefined, step.label)
}

function openReason(application: ApiApplication, status: 'rejected' | 'withdrawn') {
  reason.value = ''
  pending.value = { applicationId: application.id, status }
}

async function submitPending() {
  if (!pending.value) return
  const required = pending.value.status === 'rejected'
  const text = reason.value.trim()
  if (required && !text) return
  const application = detail.value?.applications.find((item) => item.id === pending.value!.applicationId)
  if (!application) return
  const step = pending.value
  pending.value = null
  await runStatus(application, step.status, text || undefined, step.status === 'rejected' ? '淘汰' : '撤回')
}

async function updateCandidateStatus(status: CandidateStatus, actionLabel: string) {
  if (actingId.value || !detail.value) return
  actingId.value = 'candidate'
  clearFlags()
  try {
    const updated = await updateCandidate(detail.value.id, { status })
    if (detail.value) detail.value.status = updated.status
    feedback.value = `${actionLabel}成功，当前状态 ${CANDIDATE_STATUS_LABEL[updated.status as CandidateStatus] ?? updated.status}`
    await refresh()
  } catch (cause) {
    error.value = describeApiFailure(cause, '候选人状态更新失败').message
  } finally {
    actingId.value = ''
  }
}

async function runStatus(application: ApiApplication, status: ApiApplication['status'], reasonValue: string | undefined, actionLabel: string) {
  actingId.value = application.id
  clearFlags()
  try {
    const updated = await updateApplicationStatus(application.id, status, reasonValue)
    if (detail.value) {
      detail.value.applications = detail.value.applications.map((item) => item.id === updated.id ? updated : item)
    }
    feedback.value = `${actionLabel}成功，当前状态 ${APP_STATUS_LABEL[updated.status] ?? updated.status}`
  } catch (cause) {
    error.value = describeApiFailure(cause, '申请操作失败').message
  } finally {
    actingId.value = ''
  }
}

// ---- 新建申请（候选人可申请多个岗位，后端会阻止重复申请同一岗位）----
const showCreateApplication = ref(false)
const creatingApplication = ref(false)
const applicationForm = ref({ jobId: '', source: '' })
const createApplicationOptions = ref<Array<{ value: string; label: string }>>([])
const loadingApplicationOptions = ref(false)

async function openCreateApplication() {
  clearFlags()
  applicationForm.value = { jobId: '', source: '' }
  showCreateApplication.value = true
  createApplicationOptions.value = []
  loadingApplicationOptions.value = true
  try {
    const jobs = await loadJobs()
    const applied = new Set((detail.value?.applications ?? []).map((app) => app.jobId))
    createApplicationOptions.value = jobs
      .filter((job) => !applied.has(job.entityId))
      .map((job) => ({ value: job.entityId, label: `${job.title}（${job.id}）` }))
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取岗位失败').message
  } finally {
    loadingApplicationOptions.value = false
  }
}

async function submitCreateApplication() {
  if (creatingApplication.value) return
  if (!applicationForm.value.jobId) { error.value = '请选择岗位'; return }
  creatingApplication.value = true
  clearFlags()
  try {
    const created = await createApplication({
      candidateId: id.value,
      jobId: applicationForm.value.jobId,
      source: applicationForm.value.source.trim() || undefined,
    })
    showCreateApplication.value = false
    feedback.value = `已创建申请，当前状态 ${APP_STATUS_LABEL[created.status] ?? created.status}`
    await refresh()
  } catch (cause) {
    error.value = describeApiFailure(cause, '创建申请失败').message
  } finally {
    creatingApplication.value = false
  }
}

// ---- 详情页内联简历上传与人工复核 ----
const resumeFile = ref<File | undefined>()
const resumeApplicationId = ref('')
const uploading = ref(false)
const retryingTaskId = ref('')
const reviewingResultId = ref('')
const reviewing = ref(false)
const reviewComment = ref('')
const showReview = ref(false)

function selectResumeFile(event: Event) {
  resumeFile.value = (event.target as HTMLInputElement).files?.[0]
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') { reject(new Error('读取文件失败')); return }
      const dataUrl = reader.result
      const comma = dataUrl.indexOf(',')
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl)
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function isNotFound(cause: unknown): boolean {
  return isApiClientError(cause) && (cause.status === 404 || cause.code === 'NOT_FOUND')
}

async function pollForResult(taskId: string): Promise<ApiAnalysisResult> {
  const deadline = Date.now() + 8000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await getAnalysisResult(taskId)
    } catch (cause) {
      lastError = cause
      if (!isNotFound(cause)) throw cause
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  throw lastError instanceof Error ? lastError : new Error('分析结果尚未就绪')
}

async function submitResume() {
  const file = resumeFile.value
  if (!file) { error.value = '请选择简历文件'; return }
  uploading.value = true
  clearFlags()
  try {
    const created = await uploadResume({
      candidateId: id.value,
      applicationId: resumeApplicationId.value || undefined,
      originalFilename: file.name,
      mimeType: file.type || 'application/octet-stream',
      content: await fileToBase64(file),
      encoding: 'base64',
    })
    await processAnalysisTask(created.task.id)
    let result: ApiAnalysisResult
    try {
      result = await getAnalysisResult(created.task.id)
    } catch (cause) {
      if (!isNotFound(cause)) throw cause
      result = await pollForResult(created.task.id)
    }
    feedback.value = '简历已上传并完成规则分析（AI 结果仅供人工复核参考，不会自动变更申请状态）。'
    resumeFile.value = undefined
    const input = document.querySelector<HTMLInputElement>('#candidate-detail-resume-file')
    if (input) input.value = ''
    await refresh()
    // 上传后定位到新一轮分析结果，便于立即复核。
    const matched = detail.value?.analysisResults.find((item) => item.analysisTaskId === created.task.id)
    if (matched) openReview(matched)
    void result
  } catch (cause) {
    error.value = describeApiFailure(cause, '上传简历失败').message
  } finally {
    uploading.value = false
  }
}

async function retryAnalysisTask(taskId: string) {
  if (retryingTaskId.value) return
  retryingTaskId.value = taskId
  clearFlags()
  try {
    const task = await processAnalysisTask(taskId)
    if (task.status === 'completed') {
      feedback.value = '分析任务已重新处理完成。'
    } else {
      feedback.value = `分析任务已提交，当前状态 ${task.status}`
    }
    await refresh()
  } catch (cause) {
    error.value = describeApiFailure(cause, '分析任务重试失败').message
  } finally {
    retryingTaskId.value = ''
  }
}

function openReview(result: ApiAnalysisResult) {
  clearFlags()
  reviewingResultId.value = result.id
  reviewComment.value = ''
  showReview.value = true
}

async function submitReview(status: 'accepted' | 'needs_correction') {
  if (reviewing.value || !reviewingResultId.value) return
  const comment = reviewComment.value.trim() || undefined
  if (status === 'needs_correction' && !comment) { error.value = '请填写退回修正说明'; return }
  reviewing.value = true
  clearFlags()
  try {
    await reviewAnalysisResult(reviewingResultId.value, { status, comment })
    reviewComment.value = ''
    showReview.value = false
    feedback.value = status === 'accepted' ? '已确认通过复核' : '已退回修正'
    await refresh()
  } catch (cause) {
    error.value = describeApiFailure(cause, '复核提交失败').message
  } finally {
    reviewing.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <PageHeader title="候选人详情" :description="detail ? `${detail.fullName}（${detail.code || detail.id}）` : ''">
    <div class="inline-actions">
      <button class="btn btn-ghost" type="button" @click="router.back">返回列表</button>
      <button class="btn btn-ghost" type="button" @click="refresh">刷新</button>
    </div>
  </PageHeader>

  <PageFeedback :feedback="feedback" :error="error" @clear-feedback="feedback = ''" @clear-error="error = ''" />
  <div v-if="loading" class="loading-note">正在读取候选人...</div>

  <template v-else-if="detail">
    <section class="form-panel">
      <div class="section-title">基础信息</div>
      <div class="detail-grid">
        <div class="detail-item"><span>候选人编号</span><strong>{{ detail.code || detail.id }}</strong></div>
        <div class="detail-item"><span>姓名</span><strong>{{ detail.fullName }}</strong></div>
        <div class="detail-item"><span>状态</span><StatusTag :status="detail.status" /></div>
        <div class="detail-item"><span>邮箱</span><strong>{{ detail.email || '—' }}</strong></div>
        <div class="detail-item"><span>电话</span><strong>{{ detail.phone || '—' }}</strong></div>
        <div class="detail-item"><span>来源</span><strong>{{ detail.source || '—' }}</strong></div>
        <div class="detail-item"><span>标签</span><strong>{{ (detail.tags || []).join('、') || '—' }}</strong></div>
        <div class="detail-item"><span>更新时间</span><strong>{{ (detail.updatedAt || '').slice(0, 10) || '—' }}</strong></div>
        <div class="detail-item detail-tags-actions">
          <button class="btn btn-ghost btn-sm" type="button" @click="openTagEditor">编辑标签</button>
        </div>
        <div v-if="showTagEditor" class="detail-item detail-tag-editor">
          <label for="candidate-tags">标签（用逗号分隔）</label>
          <input id="candidate-tags" v-model="tagDraft" placeholder="如：后端、高潜、内推" />
          <small class="hint">已有标签：{{ allTags.join('、') || '暂无' }}</small>
          <div class="inline-actions">
            <button class="btn btn-primary btn-sm" type="button" :disabled="savingTags" @click="saveTags">{{ savingTags ? '保存中...' : '保存标签' }}</button>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="savingTags" @click="showTagEditor = false">取消</button>
          </div>
        </div>
      </div>
    </section>

    <section class="form-panel">
      <div class="section-title panel-title">
        <span>申请记录</span>
        <button class="btn btn-primary btn-sm" type="button" @click="openCreateApplication">新建申请</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>岗位</th><th>状态</th><th>分数</th><th>AI 分析</th><th>更新时间</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="application in detail.applications" :key="application.id">
              <td><strong>{{ jobTitle(application) }}</strong></td>
              <td><StatusTag :status="application.status" /></td>
              <td>{{ application.score != null ? `${application.score}/100` : '—' }}</td>
              <td><StatusTag :status="application.aiStatus" /></td>
              <td>{{ (application.updatedAt || '').slice(0, 10) }}</td>
              <td>
                <div class="inline-actions" v-if="canOperate(application.status)">
                  <button v-if="ADVANCE[application.status]" class="btn btn-primary btn-sm" type="button" :disabled="actingId === application.id" @click="advance(application)">
                    {{ actingId === application.id ? '处理中...' : ADVANCE[application.status]!.label }}
                  </button>
                  <button class="btn btn-danger btn-sm" type="button" :disabled="actingId === application.id" @click="openReason(application, 'rejected')">淘汰</button>
                  <button class="btn btn-ghost btn-sm" type="button" :disabled="actingId === application.id" @click="openReason(application, 'withdrawn')">撤回</button>
                </div>
                <span v-else class="hint">无可执行操作</span>
              </td>
            </tr>
            <tr v-if="!detail.applications.length"><td colspan="6" class="table-empty">暂无申请记录</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="form-panel">
      <div class="section-title">上传简历并分析</div>
      <div class="form-grid">
        <div class="form-field">
          <label for="candidate-detail-resume-application">关联申请（可选）</label>
          <select id="candidate-detail-resume-application" v-model="resumeApplicationId">
            <option value="">不关联申请</option>
            <option v-for="application in detail.applications" :key="application.id" :value="application.id">{{ jobTitle(application) }}</option>
          </select>
        </div>
        <div class="form-field">
          <label for="candidate-detail-resume-file">简历文件</label>
          <input id="candidate-detail-resume-file" type="file" accept=".pdf,.doc,.docx,.txt,.md,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" @change="selectResumeFile">
          <small class="muted">文件将以二进制 base64 入库；AI 结构化解析当前对纯文本最稳定。</small>
        </div>
        <div class="form-field form-actions">
          <button class="btn btn-primary" type="button" :disabled="uploading" @click="submitResume">{{ uploading ? '处理中...' : '上传并分析' }}</button>
        </div>
      </div>
    </section>

    <section class="form-panel">
      <div class="section-title">简历（{{ detail.resumes.length }}）</div>
      <div v-if="!detail.resumes.length" class="list-muted">暂无简历</div>
      <div v-for="resume in detail.resumes" :key="resume.id" class="detail-card">
        <div class="detail-meta"><strong>{{ resume.originalFilename }}</strong><StatusTag :status="resume.scanStatus" /></div>
        <div class="list-muted">上传于 {{ (resume.createdAt || '').slice(0, 10) || '—' }}</div>
      </div>
    </section>

    <section class="form-panel">
      <div class="section-title">AI 分析任务（{{ detail.analysisTasks.length }}）</div>
      <div v-if="!detail.analysisTasks.length" class="list-muted">暂无分析任务</div>
      <div v-for="task in detail.analysisTasks" :key="task.id" class="detail-card">
        <div class="detail-meta">
          <strong>任务 {{ task.id.slice(0, 12) }}</strong>
          <StatusTag :status="task.status" />
        </div>
        <div class="list-muted">状态：{{ analysisTaskStatusLabel(task.status) }} · 尝试次数：{{ task.attempts }}</div>
        <div v-if="task.lastError" class="list-muted">失败原因：{{ task.lastError }}</div>
        <div class="inline-actions" style="margin-top:8px">
          <button
            v-if="task.status === 'failed' || task.status === 'queued'"
            class="btn btn-primary btn-sm"
            type="button"
            :disabled="retryingTaskId === task.id"
            @click="retryAnalysisTask(task.id)"
          >
            {{ retryingTaskId === task.id ? '重试中...' : '重新处理' }}
          </button>
        </div>
      </div>
    </section>

    <section class="form-panel">
      <div class="section-title">AI 分析结果（{{ detail.analysisResults.length }}）</div>
      <div v-if="!detail.analysisResults.length" class="list-muted">暂无分析结果</div>
      <div v-for="result in detail.analysisResults" :key="result.id" class="detail-card">
        <div class="detail-meta">
          <strong>综合评分：{{ result.result?.assessment?.score != null ? result.result.assessment.score : '—' }}</strong>
          <StatusTag :status="result.humanReviewStatus" />
        </div>
        <div class="list-muted">推荐结论：{{ recommendationLabel(result.result?.assessment?.recommendation) }}</div>
        <div class="list-muted">生成于 {{ (result.createdAt || '').slice(0, 10) || '—' }}</div>
        <div class="inline-actions" style="margin-top:8px">
          <button class="btn btn-ghost btn-sm" type="button" @click="openReview(result)">人工复核</button>
        </div>
      </div>
    </section>

    <section class="form-panel">
      <div class="section-title">流程审计</div>
      <WorkflowEventTable :events="auditEvents" :loading="loadingAudit" />
    </section>
  </template>

  <!-- 淘汰/撤回原因 -->
  <div v-if="pending" class="overlay" role="presentation" @click.self="pending = null">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>{{ pending.status === 'rejected' ? '淘汰候选人' : '撤回申请' }}</h3>
      <p>{{ pending.status === 'rejected' ? '请填写淘汰原因（必填）' : '可填写撤回原因（可选）' }}</p>
      <div class="form-field">
        <label for="candidate-detail-reason">操作原因</label>
        <textarea id="candidate-detail-reason" v-model="reason" rows="3" :placeholder="pending.status === 'rejected' ? '必填' : '可选'"></textarea>
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" @click="pending = null">取消</button>
        <button class="btn btn-primary" type="button" :disabled="pending.status === 'rejected' && !reason.trim()" @click="submitPending">确认</button>
      </div>
    </div>
  </div>

  <!-- 新建申请 -->
  <div v-if="showCreateApplication" class="overlay" role="presentation" @click.self="showCreateApplication = false">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>新建申请</h3>
      <div class="form-field">
        <label>岗位</label>
        <select v-model="applicationForm.jobId">
          <option value="" disabled>选择岗位</option>
          <option v-for="option in createApplicationOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <p v-if="loadingApplicationOptions" class="list-muted">正在读取岗位...</p>
        <p v-else-if="!createApplicationOptions.length" class="list-muted">暂无可申请的新岗位（已申请的岗位不会重复列出）</p>
      </div>
      <div class="form-field">
        <label>来源（可选）</label>
        <input v-model="applicationForm.source" placeholder="如 内推 / 招聘网站" />
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" @click="showCreateApplication = false">取消</button>
        <button class="btn btn-primary" type="button" :disabled="creatingApplication || !applicationForm.jobId" @click="submitCreateApplication">
          {{ creatingApplication ? '创建中...' : '创建申请' }}
        </button>
      </div>
    </div>
  </div>

  <!-- 人工复核 -->
  <div v-if="showReview" class="overlay" role="presentation" @click.self="showReview = false">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>人工复核分析结果</h3>
      <div class="form-field">
        <label for="candidate-detail-review-comment">复核说明</label>
        <textarea id="candidate-detail-review-comment" v-model="reviewComment" rows="3" placeholder="确认通过或退回修正时填写说明（退回修正必填）"></textarea>
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" @click="showReview = false">取消</button>
        <button class="btn btn-danger" type="button" :disabled="reviewing" @click="submitReview('needs_correction')">退回修正</button>
        <button class="btn btn-primary" type="button" :disabled="reviewing" @click="submitReview('accepted')">确认通过</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail-tags-actions { display: flex; align-items: center; }
.detail-tag-editor { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 6px; }
.detail-tag-editor input { width: 100%; }
.btn-sm { padding: 4px 8px; font-size: 11.5px; }
.hint { font-size: 11px; color: var(--muted); }
.list-muted { font-size: 12px; color: var(--muted); }
.muted { display: block; margin-top: 5px; font-size: 11px; color: var(--muted); }
.panel-title { display: flex; align-items: center; justify-content: space-between; }
.form-actions { display: flex; align-items: flex-end; }
</style>
