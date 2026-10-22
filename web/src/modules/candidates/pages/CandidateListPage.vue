<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  createApplication,
  createCandidate,
  deleteCandidate,
  deleteApplication,
  getAnalysisTask,
  loadCandidateTags,
  loadCandidates,
  loadJobs,
  uploadResume,
  updateResumeReview,
} from '../api'
import type { ApiApplication } from '../api'
import type { Candidate, Job } from '../../../shared/types/recruiting'
import PageHeader from '../../../shared/components/PageHeader.vue'
import CandidateTable from '../components/CandidateTable.vue'
import ResumeReviewPanel from '../components/ResumeReviewPanel.vue'
import ApplicationCreateDialog from '../components/ApplicationCreateDialog.vue'
import { aiResumeScore, canArrangeInitialInterview, canStartInitialInterview, screeningStatuses } from '../utils/ai-screening'
import { authSession } from '../../auth/session'
import { ApiClientError } from '../../../shared/api'
import { normalizeSearchText } from '../../../shared/utils/search'

const router = useRouter()
const canArrange = computed(() => ['recruiter', 'hiring_manager', 'admin', 'hr_admin', 'interviewer'].includes(authSession.user?.role ?? ''))
function arrangeApplication(applicationId: string) {
  if (!canArrange.value) return
  reviewId.value = ''
  showCreateApplication.value = false
  router.push({ name: 'interviews', query: { applicationId, stage: 'initial' } })
}
const arrangingId = ref('')
function openExistingInterview(row: Awaited<ReturnType<typeof loadCandidates>>[number]) {
  if (!row.interviewProgress) return false
  reviewId.value = ''
  router.push({ name: 'interview-detail', params: { id: row.interviewProgress.id } })
  return true
}
async function loadArrangementRow(applicationId: string) {
  const version = ++refreshVersion
  const latestRows = await loadCandidates()
  if (!disposed && version === refreshVersion) {
    rows.value = latestRows
    loading.value = false
    ensureProgressPolling()
  }
  const latest = latestRows.flatMap((candidate) => candidate.applicationRows || [candidate])
    .find((candidate) => candidate.applicationId === applicationId)
  if (!latest) throw new Error('该岗位申请已不存在或无权访问，请刷新后重试')
  return latest
}
async function openArrange(row: Awaited<ReturnType<typeof loadCandidates>>[number]) {
  if (!canArrange.value || !row.applicationId || arrangingId.value) return
  arrangingId.value = row.applicationId
  error.value = ''
  try {
    const latest = await loadArrangementRow(row.applicationId)
    if (openExistingInterview(latest)) return
    if (latest.rawApplicationStatus !== 'interviewing') {
      if (!canDelete.value || !canStartInitialInterview(latest) || !latest.resumeReview) throw new Error('需完成 AI 评分，且具备筛选权限并处于简历筛选阶段，才能进入初试邀约')
      try {
        await updateResumeReview(latest.resumeReview.resultId, { decision: 'passed' })
      } catch (cause) {
        // Another session may have passed screening after the status check.
        if (!(cause instanceof ApiClientError) || cause.code !== 'APPLICATION_REVIEW_CLOSED') throw cause
        const current = await loadArrangementRow(row.applicationId)
        if (openExistingInterview(current)) return
        if (current.rawApplicationStatus !== 'interviewing') throw cause
      }
      await refresh(true)
      const current = rows.value.flatMap((candidate) => candidate.applicationRows || [candidate]).find((candidate) => candidate.applicationId === row.applicationId)
      if (current && openExistingInterview(current)) return
    }
    arrangeApplication(row.applicationId)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '进入初试邀约失败，请重试'
  } finally {
    arrangingId.value = ''
  }
}

function openDetail(row: Awaited<ReturnType<typeof loadCandidates>>[number]) {
  router.push({ name: 'candidate-detail', params: { id: row.entityId || row.id }, query: row.applicationId ? { applicationId: row.applicationId } : {} })
}

const rows = ref<Awaited<ReturnType<typeof loadCandidates>>>([])
const jobs = ref<Job[]>([])
const allTags = ref<string[]>([])
const jobFilter = ref('')
const talentFilter = ref(false)
const reviewId = ref('')
const reviewAction = ref<'evidence' | 'passed' | 'eliminated'>('evidence')
const reviewKey = (row: Awaited<ReturnType<typeof loadCandidates>>[number]) => row.applicationId || row.entityId || row.id
const reviewRow = computed(() => rows.value.flatMap((row) => row.applicationRows || [row]).find((row) => reviewKey(row) === reviewId.value))
function openReview(row: Awaited<ReturnType<typeof loadCandidates>>[number], action: 'evidence' | 'passed' | 'eliminated') {
  if (!row.resumeReview) return
  reviewAction.value = action
  reviewId.value = reviewKey(row)
}
const tagFilter = ref('')
const searchQuery = ref('')
const scoreSort = ref<'none' | 'desc' | 'asc'>('none')
const jobSort = ref<'none' | 'asc' | 'desc'>('none')
const unprocessedStatuses = new Set(['pending', 'active', 'new', ...screeningStatuses])

const jobOptions = computed(() => [...new Set(rows.value.flatMap((row) => row.applicationRows || [row]).map((row) => row.job).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN')))

function runSearch() {
  searchQuery.value = searchQuery.value.trim()
}

const filteredRows = computed(() => {
  const query = normalizeSearchText(searchQuery.value.trim())
  const compareRows = (left: Candidate, right: Candidate) => {
    const statusOrder = Number(!unprocessedStatuses.has(left.rawApplicationStatus || left.applicationStatus))
      - Number(!unprocessedStatuses.has(right.rawApplicationStatus || right.applicationStatus))
    const updatedAtOrder = (Date.parse(right.updatedAtTimestamp || right.updatedAt) || 0)
      - (Date.parse(left.updatedAtTimestamp || left.updatedAt) || 0)
    const hasManualSort = jobSort.value !== 'none' || scoreSort.value !== 'none'

    // Default order is recency-first. Keep status as a tiebreaker so a newer
    // candidate is never pushed below an older one just because its status differs.
    if (!hasManualSort && updatedAtOrder !== 0) return updatedAtOrder
    if (hasManualSort && statusOrder !== 0) return statusOrder
    if (jobSort.value !== 'none') {
      const jobOrder = left.job.localeCompare(right.job, 'zh-CN')
      if (jobOrder !== 0) return jobSort.value === 'asc' ? jobOrder : -jobOrder
    }
    if (scoreSort.value !== 'none') {
      const leftScore = aiResumeScore(left)
      const rightScore = aiResumeScore(right)
      if (leftScore === undefined || rightScore === undefined) {
        if (leftScore !== rightScore) return leftScore === undefined ? 1 : -1
      } else if (leftScore !== rightScore) {
        return scoreSort.value === 'desc' ? rightScore - leftScore : leftScore - rightScore
      }
    }
    if (updatedAtOrder !== 0) return updatedAtOrder
    if (statusOrder !== 0) return statusOrder
    return (left.entityId || left.id).localeCompare(right.entityId || right.id)
  }
  const filtered = rows.value.flatMap((row) => {
    const matching = (row.applicationRows || [row]).filter((application) =>
      (!jobFilter.value || application.job === jobFilter.value)
      && (!talentFilter.value || application.resumeReview?.talentPool)
      && (!tagFilter.value || (application.tags ?? []).includes(tagFilter.value))
      && (!query || [application.name, application.email, application.phone, application.job, application.source, application.company, ...(application.tags ?? []), ...(application.skills ?? [])].map(normalizeSearchText).join(' ').includes(query)))
    if (!matching.length) return []
    matching.sort(compareRows)
    return [row.applicationRows ? { ...matching[0], applicationRows: matching } : row]
  })
  return filtered.sort(compareRows)
})

const loading = ref(true)
const error = ref('')
const feedback = ref('')
const deletingId = ref('')
const canDelete = computed(() => ['recruiter', 'admin', 'hr_admin'].includes(authSession.user?.role ?? ''))
let refreshVersion = 0

async function handleDelete(row: Awaited<ReturnType<typeof loadCandidates>>[number]) {
  if (!canDelete.value || deletingId.value) return
  const isApplication = !!row.applicationId
  const message = isApplication
    ? `确定删除“${row.name} · ${row.job}”这条岗位申请吗？\n仅删除此岗位申请及其 AI 分析记录，候选人档案、简历和其他岗位申请保持不变。此操作不可恢复。\n已有面试、Offer、入职记录或正在分析的申请不能直接删除。`
    : `确定删除候选人“${row.name}”吗？\n关联简历和 AI 分析记录将一并删除，此操作不可恢复。`
  if (!window.confirm(message)) return
  deletingId.value = row.applicationId || row.entityId || row.id
  error.value = ''
  feedback.value = ''
  try {
    if (row.applicationId) {
      await deleteApplication(row.applicationId)
      // Keep the candidate and sibling applications visible even if the refresh fails.
      rows.value = rows.value.map((item) => {
        if ((item.entityId || item.id) !== (row.entityId || row.id)) return item
        const remaining = (item.applicationRows || [item]).filter((application) => application.applicationId !== row.applicationId)
        return remaining.length ? { ...remaining[0], ...(remaining.length > 1 ? { applicationRows: remaining } : {}) }
          : { ...item, applicationRows: undefined, applicationId: undefined, rawApplicationStatus: undefined, resumeReview: undefined, job: '未关联岗位', score: 0, scoreAvailable: false, aiStatus: 'pending' as const, analysisStatus: undefined, analysisProgress: undefined, analysisError: undefined, analysisAttempts: undefined, applicationStatus: 'pending' as const }
      })
      feedback.value = `已删除“${row.name} · ${row.job}”的岗位申请，候选人档案与其他申请已保留。`
    } else {
      await deleteCandidate(deletingId.value)
      rows.value = rows.value.filter((item) => (item.entityId || item.id) !== deletingId.value)
      feedback.value = `已删除候选人“${row.name}”及其关联简历和分析记录。`
    }
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '删除失败'
  } finally {
    deletingId.value = ''
  }
}

const showCreateCandidate = ref(false)
type ResumeUploadEntry = {
  id: number
  file: File
  status: 'pending' | 'uploading' | 'queued' | 'failed'
  candidateId?: string
  applicationId?: string
  error?: string
}
const candidateResumeFiles = ref<ResumeUploadEntry[]>([])
const uploadDialogError = ref('')
let nextResumeEntryId = 0
const uploadCompletedCount = computed(() => candidateResumeFiles.value.filter(item => item.status === 'queued').length)
const uploadRetryCount = computed(() => candidateResumeFiles.value.filter(item => item.status === 'failed').length)
const uploadPendingCount = computed(() => candidateResumeFiles.value.filter(item => item.status === 'pending').length)
const uploadStarted = computed(() => candidateResumeFiles.value.some(item => item.candidateId || item.status === 'uploading' || item.status === 'queued'))
const uploadButtonLabel = computed(() => {
  if (creatingCandidate.value) return '上传中（' + uploadCompletedCount.value + '/' + candidateResumeFiles.value.length + '）...'
  if (uploadRetryCount.value && !uploadPendingCount.value) return '重试失败文件（' + uploadRetryCount.value + '）'
  return candidateResumeFiles.value.length > 1 ? '上传并解析（' + (uploadPendingCount.value + uploadRetryCount.value) + '份）' : '上传并解析'
})
function openResumeUpload() {
  if (creatingCandidate.value) return
  if (candidateResumeFiles.value.length && candidateResumeFiles.value.every(item => item.status === 'queued')) {
    candidateResumeFiles.value = []
    candidateJobId.value = ''
  }
  uploadDialogError.value = ''
  showCreateCandidate.value = true
}
function closeResumeUpload() {
  if (!creatingCandidate.value) showCreateCandidate.value = false
}
function removeResumeFile(id: number) {
  if (creatingCandidate.value) return
  candidateResumeFiles.value = candidateResumeFiles.value.filter(item => item.id !== id || item.status === 'queued')
}
function resumeUploadStatus(entry: ResumeUploadEntry) {
  return { pending: '待上传', uploading: '上传中...', queued: '已上传 · 已提交分析', failed: '上传失败' }[entry.status]
}
function resumeFileSize(file: File) {
  return file.size < 1024 * 1024 ? Math.max(1, Math.ceil(file.size / 1024)) + ' KB' : (file.size / (1024 * 1024)).toFixed(1) + ' MB'
}
const candidateJobId = ref('')
const creatingCandidate = ref(false)

const showCreateApplication = ref(false)
const applicationCandidateId = ref('')
const applicationTargetId = ref('')
function openApplication(row?: Awaited<ReturnType<typeof loadCandidates>>[number]) {
  applicationTargetId.value = ''
  applicationCandidateId.value = row ? row.entityId || row.id : ''
  showCreateCandidate.value = false
  showCreateApplication.value = true
}
function openApplicationAnalysis(row: Awaited<ReturnType<typeof loadCandidates>>[number]) {
  openApplication(row)
  applicationTargetId.value = row.applicationId || ''
}
async function applicationCreated(payload: { application: ApiApplication; taskId?: string; resumeName?: string }) {
  showCreateApplication.value = false
  const job = jobs.value.find((item) => (item.entityId || item.id) === payload.application.jobId)?.title || '所选岗位'
  const analyzingExisting = applicationTargetId.value === payload.application.id
  feedback.value = payload.taskId
    ? `${analyzingExisting ? '已启动' : '已创建'}“${job}”的独立${analyzingExisting ? '申请分析' : '申请'}，${payload.resumeName ? `简历“${payload.resumeName}”` : '简历'}正在后台分析，其他岗位评分与记录保持不变。`
    : `已创建“${job}”的应聘申请，尚未启动分析，可点击“解析简历”继续补充。`
  await refresh(true)
  if (payload.taskId) void pollAnalysisInBackground(payload.taskId)
}
function viewApplication(application: ApiApplication) {
  showCreateApplication.value = false
  router.push({ name: 'candidate-detail', params: { id: application.candidateId }, query: { applicationId: application.id } })
}
let progressTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false

async function refresh(silent = false) {
  const version = ++refreshVersion
  if (!silent) loading.value = true
  error.value = ''
  try {
    const [candidateRows, jobRows, tagRows] = await Promise.all([loadCandidates(), loadJobs(), loadCandidateTags()])
    if (disposed || version !== refreshVersion) return
    rows.value = candidateRows
    jobs.value = jobRows
    allTags.value = tagRows
  } catch (cause) {
    if (version === refreshVersion) error.value = cause instanceof Error ? cause.message : '读取候选人失败'
  } finally {
    if (version === refreshVersion) loading.value = false
    if (!disposed) ensureProgressPolling()
  }
}

function ensureProgressPolling() {
  const active = rows.value.flatMap((row) => row.applicationRows || [row]).some((row) => row.analysisStatus === 'queued' || row.analysisStatus === 'processing')
  if (active && !progressTimer) {
    progressTimer = setTimeout(() => {
      progressTimer = undefined
      void refresh(true)
    }, 5000)
  } else if (!active && progressTimer) {
    clearTimeout(progressTimer)
    progressTimer = undefined
  }
}

async function submitCreateCandidate() {
  if (creatingCandidate.value) return
  const entries = candidateResumeFiles.value.filter(item => item.status === 'pending' || item.status === 'failed')
  if (!entries.length) {
    uploadDialogError.value = candidateResumeFiles.value.length ? '所选文件均已提交，无需重复上传' : '请选择简历文件'
    return
  }
  if (!candidateJobId.value) { uploadDialogError.value = '请选择简历对应岗位'; return }
  const jobId = candidateJobId.value
  const jobTitle = jobs.value.find(job => (job.entityId || job.id) === jobId)?.title || '所选岗位'
  creatingCandidate.value = true
  uploadDialogError.value = ''
  error.value = ''
  feedback.value = ''
  try {
    // Sequential requests bound memory usage and avoid overwhelming the API.
    for (const entry of entries) {
      entry.status = 'uploading'
      entry.error = undefined
      try {
        // Read before creating records; retry reuses already-created IDs.
        const content = await fileToBase64(entry.file)
        if (!entry.candidateId) {
          const candidate = await createCandidate({ fullName: '待解析候选人', source: '简历导入' })
          entry.candidateId = candidate.id
        }
        if (!entry.applicationId) {
          const application = await createApplication({ candidateId: entry.candidateId, jobId })
          entry.applicationId = application.id
        }
        await uploadResume({ candidateId: entry.candidateId, applicationId: entry.applicationId, originalFilename: entry.file.name, mimeType: entry.file.type || resumeMimeType(entry.file.name), content, encoding: 'base64' })
        entry.status = 'queued'
      } catch (cause) {
        entry.status = 'failed'
        entry.error = cause instanceof Error ? cause.message : '上传失败，请重试'
      }
    }
    await refresh(true)
    const submitted = uploadCompletedCount.value
    const failed = uploadRetryCount.value
    feedback.value = submitted ? '已提交 ' + submitted + ' 份简历并关联“' + jobTitle + '”，AI 正在后台逐份解析和评分。' + (failed ? '另有 ' + failed + ' 份上传失败，可在窗口中重试。' : '') : ''
    if (failed) uploadDialogError.value = failed + ' 份简历上传失败，请查看各文件原因并重试；成功文件不会重复上传。'
    if (candidateResumeFiles.value.length === 1 && !failed) showCreateCandidate.value = false
  } finally { creatingCandidate.value = false }
}
function resumeMimeType(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase()
  return ({ pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain', md: 'text/markdown' } as Record<string, string>)[extension || ''] || 'application/octet-stream'
}
function selectResumeFile(event: Event) {
  if (creatingCandidate.value) return
  const input = event.target as HTMLInputElement
  const rejected: string[] = []
  for (const file of Array.from(input.files || [])) {
    if (!/\.(pdf|doc|docx|txt|md)$/i.test(file.name)) { rejected.push(file.name + '：不支持此文件格式'); continue }
    if (!file.size) { rejected.push(file.name + '：文件为空'); continue }
    if (file.size > 10 * 1024 * 1024) { rejected.push(file.name + '：单份简历不能超过 10 MB'); continue }
    if (candidateResumeFiles.value.some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) continue
    candidateResumeFiles.value.push({ id: ++nextResumeEntryId, file, status: 'pending' })
  }
  uploadDialogError.value = rejected.join('；')
  input.value = ''
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
    reader.onabort = () => reject(new Error('文件读取已取消，请重试'))
    reader.readAsDataURL(file)
  })
}

async function pollAnalysisInBackground(taskId: string): Promise<void> {
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    if (disposed) return
    try {
      const task = await getAnalysisTask(taskId)
      if (task.status === 'completed') {
        feedback.value = 'AI 后台评分已完成，候选人列表已刷新。'
        await refresh(true)
        return
      }
      if (task.status === 'failed') {
        await refresh(true)
        error.value = `AI 后台评分失败：${task.lastError || '请稍后重试'}`
        return
      }
    } catch {
      return
    }
  }
}

onMounted(refresh)
onUnmounted(() => { disposed = true; refreshVersion += 1; if (progressTimer) clearTimeout(progressTimer) })
</script>

<template>
  <div v-if="reviewRow?.resumeReview" class="overlay" role="presentation" @click.self="reviewId = ''">
    <div class="dialog score-review-dialog" role="dialog" aria-modal="true" aria-labelledby="resume-review-title">
      <div class="review-dialog-head"><h3 id="resume-review-title">{{ reviewRow.name }} · {{ reviewRow.job }} · 简历评分与筛选</h3><button class="btn btn-ghost" type="button" @click="reviewId = ''">关闭</button></div>
      <div v-if="canArrange && canArrangeInitialInterview(reviewRow) && (reviewRow.rawApplicationStatus === 'interviewing' || canDelete)" class="inline-actions">
        <button class="btn btn-primary" type="button" :disabled="!!arrangingId" @click="openArrange(reviewRow)">{{ arrangingId ? '处理中…' : '下一步：初试邀约' }}</button>
      </div>
      <div class="review-dialog-body">
        <ResumeReviewPanel :key="reviewRow.resumeReview.resultId" :summary="reviewRow.resumeReview" :application-status="reviewRow.rawApplicationStatus" :can-edit="canDelete" :busy="['queued', 'processing'].includes(reviewRow.analysisStatus || '')" :initial-action="reviewAction" @saved="refresh(true)" />
      </div>
    </div>
  </div>
  <PageHeader title="简历库 · AI 评分">
    <div class="inline-actions">
      <button class="btn btn-ghost" type="button" @click="refresh()">刷新</button>
      <button class="btn btn-primary" type="button" :disabled="creatingCandidate" @click="showCreateApplication = false; openResumeUpload()">上传简历并建档</button>
      <button class="btn btn-primary" type="button" :disabled="creatingCandidate" @click="openApplication()">新建应聘申请</button>
    </div>
  </PageHeader>

  <div class="entry-guide"><span><strong>上传简历并建档</strong> · 新人首次应聘，自动建档、关联岗位并分析</span><span><strong>新建应聘申请</strong> · 已有人才应聘新岗位，复用档案与简历、独立评分</span></div>
  <label class="talent-filter"><input v-model="talentFilter" type="checkbox" />只看人才库</label>

  <div v-if="showCreateCandidate" class="overlay resume-overlay" role="presentation" @click.self="closeResumeUpload">
    <div class="dialog candidate-dialog resume-dialog" role="dialog" aria-modal="true" aria-labelledby="resume-dialog-title">
      <div class="resume-dialog-header">
        <div class="resume-title-wrap">
          <div class="resume-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M6.5 3.75h7.3L18 7.95v12.3H6.5z"/><path d="M13.5 3.75v4.5H18M9 12h6M9 15.5h4.5"/></svg>
          </div>
          <div>
            <span class="resume-eyebrow">CANDIDATE PROFILE</span>
            <h3 id="resume-dialog-title">上传简历自动建库</h3>
          </div>
        </div>
        <button class="resume-close" type="button" aria-label="关闭上传简历窗口" :disabled="creatingCandidate" @click="closeResumeUpload">×</button>
      </div>
      <p class="resume-dialog-intro">支持上传单份或同时上传多份简历，系统会逐份识别候选人信息并完成建库。</p>
      <div v-if="uploadDialogError" class="error-note resume-upload-error" role="alert">{{ uploadDialogError }}</div>
      <div class="resume-form-grid">
        <div class="form-field resume-file-field">
          <label for="candidate-resume-file">简历文件</label>
          <label class="resume-upload-box" for="candidate-resume-file">
            <span class="upload-box-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M12 16V5M8 9l4-4 4 4M5 14.5v3.25A1.75 1.75 0 0 0 6.75 19.5h10.5A1.75 1.75 0 0 0 19 17.75V14.5"/></svg>
            </span>
            <span class="upload-box-copy">
              <strong>{{ candidateResumeFiles.length ? '已选择 ' + candidateResumeFiles.length + ' 份简历' : '点击选择一份或多份简历' }}</strong>
              <small>支持 PDF、Word、TXT、Markdown，单份不超过 10 MB</small>
            </span>
            <span class="upload-box-action">{{ candidateResumeFiles.length ? '继续添加' : '浏览文件' }}</span>
            <input id="candidate-resume-file" class="resume-file-input" type="file" multiple :disabled="creatingCandidate" accept=".pdf,.doc,.docx,.txt,.md,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" @change="selectResumeFile">
          </label>
          <ul v-if="candidateResumeFiles.length" class="resume-file-list" aria-label="已选择的简历">
            <li v-for="entry in candidateResumeFiles" :key="entry.id" class="resume-file-row" :data-status="entry.status">
              <div class="resume-file-info"><strong :title="entry.file.name">{{ entry.file.name }}</strong><small>{{ resumeFileSize(entry.file) }} · {{ resumeUploadStatus(entry) }}</small><small v-if="entry.error" class="resume-file-error">{{ entry.error }}</small><small v-if="entry.status === 'failed' && entry.candidateId">候选人档案已创建，重试将复用，不会重复建档。</small></div>
              <button v-if="entry.status !== 'queued'" class="resume-remove" type="button" :disabled="creatingCandidate" :aria-label="'移除 ' + entry.file.name" @click="removeResumeFile(entry.id)">移除</button>
            </li>
          </ul>
          <small class="muted resume-note">可多选文件或继续添加；每份简历单独建立候选人档案，解析姓名、邮箱和电话。</small>
        </div>
        <div class="form-field resume-job-field">
          <label for="candidate-resume-job">对应岗位 <span class="required">*</span></label>
          <div class="resume-select-wrap">
            <select id="candidate-resume-job" v-model="candidateJobId" :disabled="creatingCandidate || uploadStarted" aria-label="上传简历岗位">
              <option value="" disabled>请选择这些简历对应的岗位</option>
              <option v-for="job in jobs" :key="job.entityId || job.id" :value="job.entityId || job.id">{{ job.title }}</option>
            </select>
          </div>
          <small class="muted resume-note">本批简历统一关联所选岗位，各自独立评分。不同岗位请分批上传。</small>
        </div>
      </div>
      <div class="resume-dialog-footer">
        <span class="resume-security"><span class="security-dot"></span> 文件仅用于候选人建档与分析</span>
        <div class="dialog-buttons">
          <button class="btn btn-ghost" type="button" :disabled="creatingCandidate" @click="closeResumeUpload">{{ uploadCompletedCount ? '完成' : '取消' }}</button>
          <button class="btn btn-primary resume-submit" type="button" :disabled="creatingCandidate || (candidateResumeFiles.length > 0 && !uploadPendingCount && !uploadRetryCount)" @click="submitCreateCandidate"><span class="button-spark" aria-hidden="true">✦</span>{{ uploadButtonLabel }}</button>
        </div>
      </div>
    </div>
  </div>
  <ApplicationCreateDialog v-if="showCreateApplication" :candidates="rows" :jobs="jobs" :initial-candidate-id="applicationCandidateId" :initial-application-id="applicationTargetId" :can-arrange="canArrange" @arrange="arrangeApplication" @close="showCreateApplication = false" @changed="refresh(true)" @created="applicationCreated" @view="viewApplication" />

  <div v-if="feedback" class="success-note">{{ feedback }}</div>
  <div v-if="error" class="error-note">{{ error }}</div>
  <div v-if="loading" class="loading-note">正在读取候选人...</div>
  <div v-else class="filter-bar">
    <div class="search-field">
    <input v-model="searchQuery" class="candidate-search" type="search" aria-label="简历库搜索" placeholder="搜索姓名、公司、技能、岗位" @keyup.enter="runSearch" />
    <button class="btn btn-ghost" type="button" @click="runSearch">搜索</button>
    </div>
    <div class="filter-field">
    <label for="candidate-job-filter">岗位筛选</label>
    <select id="candidate-job-filter" v-model="jobFilter" aria-label="岗位筛选">
      <option value="">全部岗位</option>
      <option v-for="job in jobOptions" :key="job" :value="job">{{ job }}</option>
    </select>
    </div>
    <div v-if="allTags.length" class="filter-field">
      <label for="candidate-tag-filter">标签筛选</label>
      <select id="candidate-tag-filter" v-model="tagFilter">
        <option value="">全部标签</option>
        <option v-for="tag in allTags" :key="tag" :value="tag">{{ tag }}</option>
      </select>
    </div>
    <div class="filter-field">
    <label for="candidate-score-sort">评分排序</label>
    <select id="candidate-score-sort" v-model="scoreSort" aria-label="评分排序">
      <option value="none">默认排序</option>
      <option value="desc">评分从高到低</option>
      <option value="asc">评分从低到高</option>
    </select>
    </div>
    <div class="filter-field">
    <label for="candidate-job-sort">岗位排序</label>
    <select id="candidate-job-sort" v-model="jobSort" aria-label="岗位排序">
      <option value="none">默认排序</option>
      <option value="asc">岗位 A→Z</option>
      <option value="desc">岗位 Z→A</option>
    </select>
    </div>
  </div>
  <CandidateTable
    v-if="!loading"
    :rows="filteredRows"
    :can-delete="canDelete"
    :can-review="canDelete"
    :can-arrange="canArrange"
    :can-apply="canDelete"
    :deleting-id="deletingId"
    @open="openDetail"
    @arrange="openArrange"
    @delete="handleDelete"
    @apply="openApplication" @analyze="openApplicationAnalysis"
    @review="openReview"
  />
</template>

<style scoped>
.entry-guide { display: flex; flex-wrap: wrap; gap: 12px 24px; margin: 0 0 14px; padding: 12px 16px; border: 1px solid #dbeafe; border-radius: 10px; background: #f8fbff; color: #64748b; font-size: 12px; line-height: 1.7; }.entry-guide strong { color: #1e40af; }
.score-review-dialog { display: flex; flex-direction: column; width: min(920px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow: hidden; padding: 0; box-sizing: border-box; }
.review-dialog-head { display: flex; flex-shrink: 0; justify-content: space-between; align-items: center; gap: 12px; padding: 18px; background: #fff; border-bottom: 1px solid #e2e8f0; }
.review-dialog-head h3 { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.review-dialog-head button { flex-shrink: 0; border-color: #dc2626; color: #dc2626; background: #fff; }
.review-dialog-head button:hover { border-color: #b91c1c; color: #b91c1c; background: #fef2f2; }
.review-dialog-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 18px; }
.talent-filter { display: flex; align-items: center; gap: 8px; margin: 10px 0 14px; font-size: 13px; color: #64748b; }
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 4px 0 16px;
  padding: 12px;
  border: 1px solid #e1edf4;
  border-radius: 18px;
  background: linear-gradient(135deg, rgba(255, 255, 255, .96), rgba(242, 249, 252, .92));
  box-shadow: 0 9px 24px rgba(68, 111, 139, .08), inset 0 1px 0 rgba(255, 255, 255, .9);
  transition: box-shadow .2s ease, border-color .2s ease;
}
.filter-bar:focus-within {
  border-color: #b9d9ec;
  box-shadow: 0 12px 28px rgba(68, 111, 139, .11), 0 0 0 3px rgba(91, 155, 243, .08);
}
.search-field { display: flex; align-items: center; gap: 10px; flex: 1 1 280px; min-width: 0; }
.filter-field { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 0 1 220px; }
.filter-field > label {
  display: inline-flex;
  align-items: center;
  min-height: 38px;
  padding: 0 2px 0 4px;
  color: #6f879a;
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
}
.filter-field > label::before {
  width: 5px;
  height: 5px;
  margin-right: 6px;
  border-radius: 50%;
  background: #78c9b5;
  content: '';
}
.filter-bar input,
.filter-bar select {
  min-height: 38px;
  border: 1px solid #d8e7ef;
  border-radius: 11px;
  outline: none;
  background: rgba(255, 255, 255, .9);
  color: #36536a;
  box-shadow: 0 2px 5px rgba(68, 111, 139, .035), inset 0 1px 0 rgba(255, 255, 255, .85);
  transition: border-color .18s ease, box-shadow .18s ease, background .18s ease, transform .18s ease;
}
.filter-bar input { padding: 0 12px; }
.filter-bar select {
  flex: 1;
  width: 150px;
  min-width: 0;
  padding: 0 32px 0 11px;
  cursor: pointer;
}
.filter-bar input:hover,
.filter-bar select:hover {
  border-color: #afd2e4;
  background: #fff;
  transform: translateY(-1px);
}
.filter-bar input:focus,
.filter-bar select:focus {
  border-color: #66b8d0;
  background: #fff;
  box-shadow: 0 0 0 3px rgba(102, 184, 208, .14), 0 5px 12px rgba(68, 111, 139, .07);
}
.candidate-search {
  flex: 1;
  width: 100%;
  min-width: 0;
}
.search-field > .btn {
  flex-shrink: 0;
  white-space: nowrap;
  min-height: 38px;
  border-radius: 11px;
  padding: 0 14px;
  transition: transform .18s ease, box-shadow .18s ease, background .18s ease;
}
.search-field > .btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 5px 12px rgba(68, 111, 139, .1);
}
.search-field > .btn:active,
.filter-bar input:active,
.filter-bar select:active {
  transform: translateY(0) scale(.98);
}
.muted { display: block; margin-top: 5px; font-size: 11px; }
.btn:disabled { opacity: 0.6; cursor: wait; }
.success-note { margin: 10px 0; padding: 10px 12px; background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; border-radius: 7px; font-size: 12px; }
.candidate-dialog { max-width: 720px; max-height: min(86vh, 720px); overflow-y: auto; }
@media (max-width: 1440px) {
  .search-field { flex-basis: 100%; }
  .filter-field { flex: 1 1 180px; }
}
@media (max-width: 760px) {
  .filter-bar { align-items: stretch; padding: 10px; border-radius: 15px; }
  .search-field { flex-basis: 100%; }
  .filter-field { flex-basis: 240px; }
}
.resume-overlay {
  background: rgba(30, 52, 74, .42);
  backdrop-filter: blur(5px);
  -webkit-backdrop-filter: blur(5px);
}
.resume-dialog {
  max-width: 720px;
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, .9);
  border-radius: 24px;
  background: linear-gradient(145deg, rgba(255, 255, 255, .98), rgba(245, 251, 253, .98));
  box-shadow: 0 26px 80px rgba(43, 80, 112, .25), 0 4px 18px rgba(43, 80, 112, .08);
}
.resume-dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 25px 28px 18px;
  background: radial-gradient(circle at 100% 0%, rgba(99, 192, 205, .18), transparent 42%), linear-gradient(135deg, #f8fcff, #edf9f8);
  border-bottom: 1px solid #e3eef3;
}
.resume-title-wrap { display: flex; align-items: center; gap: 13px; }
.resume-icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  border-radius: 14px;
  background: linear-gradient(145deg, #4fbecc, #5e8ee9);
  color: #fff;
  box-shadow: 0 9px 18px rgba(75, 151, 206, .2);
}
.resume-icon svg, .upload-box-icon svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
.resume-eyebrow { display: block; margin-bottom: 3px; color: #59a1ad; font-size: 10px; font-weight: 800; letter-spacing: .16em; }
.resume-dialog h3 { margin: 0; color: #19374f; font-size: 22px; letter-spacing: -.04em; }
.resume-close {
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid #dceaf0;
  border-radius: 10px;
  background: rgba(255, 255, 255, .72);
  color: #7690a1;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  transition: transform .18s ease, background .18s ease, color .18s ease;
}
.resume-close:hover { transform: rotate(8deg); background: #fff; color: #3d7588; }
.resume-dialog-intro { margin: 0; padding: 22px 30px 0; color: #6c8493; font-size: 12.5px; line-height: 1.7; }
.resume-form-grid { display: grid; grid-template-columns: minmax(0, 1.18fr) minmax(220px, .82fr); column-gap: 28px; row-gap: 26px; padding: 22px 30px 30px; }
.resume-form-grid .form-field { min-width: 0; }
.resume-form-grid .form-field > label:first-child { display: block; margin-bottom: 8px; color: #496c80; font-size: 12px; font-weight: 750; }
.resume-upload-box {
  display: flex !important;
  align-items: center;
  gap: 12px;
  min-height: 92px;
  margin: 0 !important;
  padding: 15px 16px;
  border: 1px dashed #a9d2dc;
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(245, 253, 253, .94), rgba(239, 247, 255, .92));
  color: #375b70;
  cursor: pointer;
  transition: border-color .2s ease, background .2s ease, transform .2s ease, box-shadow .2s ease;
}
.resume-upload-box:hover { border-color: #5cb9c4; background: #f7ffff; transform: translateY(-1px); box-shadow: 0 8px 18px rgba(81, 155, 176, .11); }
.upload-box-icon { display: grid; place-items: center; width: 38px; height: 38px; flex: 0 0 38px; border-radius: 12px; background: #dff4f2; color: #39a5a4; }
.upload-box-copy { min-width: 0; flex: 1; }
.upload-box-copy strong, .upload-box-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.upload-box-copy strong { color: #31566c; font-size: 13px; }
.upload-box-copy small { margin-top: 5px; color: #89a0ad; font-size: 11px; }
.upload-box-action { flex: 0 0 auto; padding: 7px 10px; border-radius: 9px; background: rgba(255, 255, 255, .82); color: #4e94a2; font-size: 11px; font-weight: 700; }
.resume-file-input { display: none !important; }
.resume-upload-error { margin: 16px 30px 0; }
.resume-file-list { display: grid; gap: 8px; max-height: 230px; overflow-y: auto; padding: 0; margin: 12px 0 0; list-style: none; }
.resume-file-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid #dceaf0; border-radius: 10px; background: #fff; }
.resume-file-info { flex: 1; min-width: 0; }
.resume-file-info strong { display: block; overflow-wrap: anywhere; color: #31566c; font-size: 12px; }
.resume-file-info small { display: block; margin-top: 4px; color: #7b909d; font-size: 11px; }
.resume-file-row[data-status="queued"] { border-color: #bce6d9; background: #f5fcf9; }
.resume-file-row[data-status="failed"] { border-color: #f3caca; background: #fffafa; }
.resume-file-info .resume-file-error { color: #b91c1c; }
.resume-remove { flex: 0 0 auto; padding: 4px 6px; background: transparent; border: 0; color: #8e6370; font-size: 11px; cursor: pointer; }
.resume-remove:disabled, .resume-close:disabled { cursor: not-allowed; opacity: .5; }
.resume-dialog .upload-box-copy small { white-space: normal; line-height: 1.6; }
.resume-note { margin-top: 12px; line-height: 1.65; }
.resume-select-wrap { position: relative; }
.resume-select-wrap::after { position: absolute; top: 50%; right: 14px; width: 7px; height: 7px; border-right: 1.5px solid #6e8c9d; border-bottom: 1.5px solid #6e8c9d; content: ''; pointer-events: none; transform: translateY(-65%) rotate(45deg); }
.resume-select-wrap select { min-height: 52px; padding: 0 38px 0 14px; border: 1px solid #d2e3ea; border-radius: 13px; background: rgba(255, 255, 255, .9); color: #34566d; cursor: pointer; transition: border-color .18s ease, box-shadow .18s ease; appearance: none; }
.resume-select-wrap select:focus { border-color: #64bac4; box-shadow: 0 0 0 4px rgba(100, 186, 196, .14); outline: 0; }
.resume-dialog-footer { display: flex; align-items: center; justify-content: space-between; gap: 22px; padding: 20px 30px 24px; border-top: 1px solid #e7f0f3; background: rgba(250, 253, 254, .75); }
.resume-security { color: #7f99a5; font-size: 11px; }
.security-dot { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: #60c6ae; box-shadow: 0 0 0 4px rgba(96, 198, 174, .12); }
.resume-dialog .dialog-buttons { margin-top: 0; }
.resume-dialog .btn { min-height: 40px; border-radius: 11px; padding: 0 15px; }
.resume-submit { display: inline-flex; align-items: center; gap: 7px; box-shadow: 0 8px 16px rgba(67, 137, 221, .2); }
.button-spark { font-size: 15px; line-height: 1; }
@media (max-width: 680px) {
  .resume-dialog-header { padding: 21px 20px 16px; }
  .resume-dialog-intro { padding: 16px 20px 0; }
  .resume-form-grid { grid-template-columns: 1fr; padding: 16px 20px 20px; }
  .resume-dialog-footer { align-items: flex-start; flex-direction: column; padding: 15px 20px 18px; }
  .resume-dialog-footer .dialog-buttons { align-self: flex-end; }
}</style>
