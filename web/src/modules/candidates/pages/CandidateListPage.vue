<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { RefreshCw, Trash2, X } from '@lucide/vue'
import {
  analyzeResumeForApplication,
  cancelResumeImportBatch,
  createResumeImportBatch,
  deleteCandidate,
  deleteApplication,
  getAnalysisTask,
  getApplicationResume,
  getCandidate,
  getResumeImportBatch,
  loadCandidateTags,
  loadCandidates,
  loadJobs,
  uploadResumeImportItem,
  updateResumeReview,
} from '../api'
import type { ApiApplication } from '../api'
import type { Candidate, Job } from '../../../shared/types/recruiting'
import PageHeader from '../../../shared/components/PageHeader.vue'
import CandidateTable from '../components/CandidateTable.vue'
import ResumeReviewPanel from '../components/ResumeReviewPanel.vue'
import ApplicationCreateDialog from '../components/ApplicationCreateDialog.vue'
import InitialInterviewDialog from '../../interviews/components/InitialInterviewDialog.vue'
import { aiResumeScore, canArrangeInitialInterview, canStartInitialInterview, screeningStatuses } from '../utils/ai-screening'
import { authSession } from '../../auth/session'
import { isEnterpriseUser } from '../../auth/utils/enterprise-access'
import { ApiClientError } from '../../../shared/api'
import { normalizeSearchText } from '../../../shared/utils/search'
import { runResumeUploadQueue } from '../utils/resume-upload-queue'
import { isActiveResumeImportStatus, resumeImportBatchPhase, resumeImportItemStatus, type ResumeUploadStatus } from '../utils/resume-import-progress'
import type { ApiResumeImportBatchPhase } from '../api'

defineOptions({ name: 'CandidateListPage' })

const router = useRouter()
const candidateTable = ref<InstanceType<typeof CandidateTable>>()
let tableScrollLeft = 0
onBeforeRouteLeave(() => {
  tableScrollLeft = (candidateTable.value?.$el as HTMLElement | undefined)?.scrollLeft ?? 0
})
const invitationApplicationId = ref('')
const canArrange = computed(() => isEnterpriseUser(authSession.user))
function arrangeApplication(applicationId: string) {
  if (!canArrange.value) return
  reviewId.value = ''
  showCreateApplication.value = false
  invitationApplicationId.value = applicationId
}
async function interviewCreated() {
  invitationApplicationId.value = ''
  await refresh(true)
  feedback.value = '初试邀约已创建'
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
  if (!disposed && !operationBusy.value && version === refreshVersion) {
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
  if (!canArrange.value || operationBusy.value || !row.applicationId || arrangingId.value) return
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
  if (operationBusy.value || !row.resumeReview) return
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

    // 默认按有效更新时间倒序；只有用户主动选择其他排序时才保留状态优先。
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
        // 未评分的简历始终排在已评分之后，避免把“暂无分数”误当成低分或高分。
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
const canDelete = computed(() => isEnterpriseUser(authSession.user))
let refreshVersion = 0

const selectedRows = ref<Candidate[]>([])
const batchDeleting = ref(false)
const batchAnalyzing = ref(false)
const batchAnalysisProgress = ref(0)
const batchAnalysisTotal = ref(0)
const batchAnalysisNotes = ref<string[]>([])
const operationBusy = computed(() => batchDeleting.value || batchAnalyzing.value || !!deletingId.value)
const batchDeleteFailures = ref<string[]>([])

function removeDeletedRow(row: Candidate, candidateDeleted: boolean) {
  rows.value = rows.value.flatMap((item) => {
    if ((item.entityId || item.id) !== (row.entityId || row.id)) return [item]
    if (candidateDeleted) return []
    const remaining = (item.applicationRows || [item]).filter((application) => application.applicationId !== row.applicationId)
    return remaining.length ? [{ ...remaining[0], applicationRows: remaining.length > 1 ? remaining : undefined }] : []
  })
}

async function deleteRow(row: Candidate) {
  let candidateDeleted = true
  if (row.applicationId) candidateDeleted = (await deleteApplication(row.applicationId)).candidateDeleted
  else await deleteCandidate(row.entityId || row.id)
  removeDeletedRow(row, candidateDeleted)
  return candidateDeleted
}

async function handleDelete(row: Candidate) {
  if (!canDelete.value || operationBusy.value) return
  const message = row.applicationId
    ? `确定删除“${row.name} · ${row.job}”这条岗位申请吗？\n申请及其独占简历和 AI 分析记录将一并清理；若是最后一条申请，候选人档案及全部简历也将一并删除，无需再次删除档案。其他岗位申请及其共用资料保持不变。此操作不可恢复。\n已有面试、Offer、入职记录或正在分析的申请不能直接删除。`
    : `确定删除候选人“${row.name}”吗？\n关联简历和 AI 分析记录将一并删除，此操作不可恢复。`
  if (!window.confirm(message)) return
  deletingId.value = row.applicationId || row.entityId || row.id
  refreshVersion += 1
  error.value = ''
  feedback.value = ''
  batchDeleteFailures.value = []
  batchAnalysisNotes.value = []
  try {
    const candidateDeleted = await deleteRow(row)
    feedback.value = candidateDeleted
      ? `已删除候选人“${row.name}”及其关联申请、简历和分析记录。`
      : `已删除“${row.name} · ${row.job}”的岗位申请及其独占资料，其他申请及其共用资料已保留。`
    await refresh(true, true)
    await refreshImportBatch()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '删除失败'
  } finally {
    deletingId.value = ''
  }
}

async function handleBatchDelete() {
  if (!canDelete.value || operationBusy.value || !selectedRows.value.length) return
  const targets = [...selectedRows.value]
  const applications = targets.filter((row) => row.applicationId).length
  const candidates = targets.length - applications
  const details = [applications ? `${applications} 条岗位申请（清理独占简历和分析记录；最后一条申请删除后，档案及全部简历自动删除；其他申请及其共用资料保留）` : '', candidates ? `${candidates} 份未关联岗位的候选人档案（同时删除其简历和分析记录）` : ''].filter(Boolean).join('；')
  if (!window.confirm(`确定批量删除已勾选的 ${targets.length} 条记录吗？\n${details}。此操作不可恢复。\n已有面试、Offer、入职记录或正在分析的申请不能直接删除，失败记录将保留。`)) return
  batchDeleting.value = true
  refreshVersion += 1
  error.value = ''
  feedback.value = ''
  batchDeleteFailures.value = []
  batchAnalysisNotes.value = []
  let succeeded = 0
  try {
    // Reuse scoped deletion endpoints so every record retains server-side safeguards.
    for (const row of targets) {
      deletingId.value = row.applicationId || row.entityId || row.id
      try {
        await deleteRow(row)
        succeeded += 1
      } catch (cause) {
        batchDeleteFailures.value.push(`${row.name}${row.applicationId ? ' · ' + row.job : ''}：${cause instanceof Error ? cause.message : '删除失败'}`)
      }
    }
    await refresh(true, true)
    await refreshImportBatch()
    feedback.value = `批量删除完成：成功 ${succeeded} 条，失败 ${batchDeleteFailures.value.length} 条。`
  } finally {
    deletingId.value = ''
    batchDeleting.value = false
  }
}

function updateAnalysisRow(applicationId: string, task: { status: string; attempts: number; lastError?: string }) {
  const patch = (row: Candidate): Candidate => row.applicationId === applicationId
    ? { ...row, analysisStatus: task.status, analysisProgress: task.status === 'completed' ? 100 : task.status === 'processing' ? 50 : 0, analysisAttempts: task.attempts, analysisError: task.lastError }
    : row
  rows.value = rows.value.map((row) => {
    const applications = row.applicationRows?.map(patch)
    return { ...patch(row), ...(applications ? { applicationRows: applications } : {}) }
  })
}

let analysisRunVersion = 0
async function handleBatchAnalyze() {
  if (!canDelete.value || operationBusy.value || !selectedRows.value.length) return
  const targets = [...selectedRows.value]
  if (!window.confirm(`确定对已勾选的 ${targets.length} 条记录批量重新解析简历吗？\n按每条岗位申请原有关联的简历重新分析，使用当前企业配置的 AI 模型。已完成的分析也会重新提交；排队中、解析中、未关联岗位或已进入后续流程的记录将跳过。`)) return
  const userId = authSession.user?.id
  const workspaceId = authSession.user?.workspaceId
  const version = ++analysisRunVersion
  const current = () => !disposed && !suspended && version === analysisRunVersion
    && authSession.user?.id === userId && authSession.user?.workspaceId === workspaceId
  batchAnalyzing.value = true
  batchAnalysisProgress.value = 0
  batchAnalysisTotal.value = targets.length
  refreshVersion += 1
  error.value = ''
  feedback.value = ''
  batchDeleteFailures.value = []
  batchAnalysisNotes.value = []
  let submitted = 0
  let skipped = 0
  let failed = 0
  const queuedApplications: string[] = []
  const skip = (row: Candidate, reason: string) => {
    skipped += 1
    batchAnalysisNotes.value.push(`跳过 · ${row.name} · ${row.job}：${reason}`)
  }
  try {
    // Submit sequentially through the scoped endpoint; never create new applications.
    for (const row of targets) {
      if (!current()) break
      try {
        if (!row.applicationId) { skip(row, '未关联岗位，请先创建应聘申请'); continue }
        if (['queued', 'processing'].includes(row.analysisStatus || '')) { skip(row, '已排队或正在解析'); continue }
        const candidateId = row.entityId || row.id
        const detail = await getCandidate(candidateId)
        if (!current()) break
        const application = detail.applications.find((item) => item.id === row.applicationId)
        if (detail.id !== candidateId || !application || application.candidateId !== candidateId) throw new Error('岗位申请已不存在或无权访问')
        if (!['pending_analysis', 'analysis_queued', 'human_review'].includes(application.status)) { skip(row, '已进入后续流程，不能重新解析'); continue }
        const active = detail.analysisTasks.find((task) => task.applicationId === application.id && ['queued', 'processing'].includes(task.status))
        if (active || ['queued', 'processing'].includes(application.analysisStatus || '')) {
          updateAnalysisRow(application.id, active || { status: application.analysisStatus!, attempts: application.analysisAttempts || 0 })
          skip(row, '已排队或正在解析')
          queuedApplications.push(application.id)
          continue
        }
        const resume = await getApplicationResume(application.id)
        if (!current()) break
        if (!resume) { skip(row, '没有关联的简历，请先上传或选择简历'); continue }
        if (resume.candidateId !== candidateId) throw new Error('关联简历与候选人不一致')
        if (resume.scanStatus === 'infected') { skip(row, '简历被安全检查标记为感染，不能解析'); continue }
        const task = await analyzeResumeForApplication(candidateId, resume.id, application.id)
        submitted += 1
        if (!current()) break
        updateAnalysisRow(application.id, task)
        queuedApplications.push(application.id)
      } catch (cause) {
        if (!current()) break
        failed += 1
        batchAnalysisNotes.value.push(`失败 · ${row.name} · ${row.job}：${cause instanceof Error ? cause.message : '提交解析失败'}`)
      } finally {
        if (current()) batchAnalysisProgress.value += 1
      }
    }
    if (current()) {
      candidateTable.value?.deselectApplications(queuedApplications)
      feedback.value = `批量重新解析提交完成：已提交 ${submitted} 条，跳过 ${skipped} 条，失败 ${failed} 条。`
    }
  } finally {
    batchAnalyzing.value = false
    ensureProgressPolling()
  }
}

const showCreateCandidate = ref(false)
type ResumeUploadEntry = {
  id: number
  clientFileId?: string
  file?: File
  originalFilename: string
  mimeType: string
  sizeBytes: number
  status: ResumeUploadStatus
  progress: number
  serverItemId?: string
  candidateId?: string
  applicationId?: string
  analysisTaskId?: string
  error?: string
}
const RESUME_IMPORT_BATCH_KEY = 'smartrecruit:active-resume-import-batch'
const MAX_RESUME_FILES_PER_BATCH = 500
const candidateResumeFiles = ref<ResumeUploadEntry[]>([])
const uploadDialogError = ref('')
const activeImportBatchId = ref('')
const activeImportBatchStatus = ref<'uploading' | 'completed' | 'cancelled' | ''>('')
const activeImportBatchPhase = ref<ApiResumeImportBatchPhase | ''>('')
const dismissedImportBatchId = ref('')
const cancellingUpload = ref(false)
const hasActiveImportWork = computed(() => !!activeImportBatchId.value && (
  candidateResumeFiles.value.some(item => isActiveResumeImportStatus(item.status))
  || activeImportBatchPhase.value === 'uploading'
  || activeImportBatchPhase.value === 'waiting_analysis'
  || activeImportBatchPhase.value === 'analyzing'
))
const importBatchSummary = ref({
  phase: 'uploading' as ApiResumeImportBatchPhase,
  total: 0,
  uploaded: 0,
  uploadFailed: 0,
  uploadProcessing: 0,
  queued: 0,
  analyzing: 0,
  completed: 0,
  analysisFailed: 0,
  removed: 0,
  cancelled: 0,
  terminalAnalysis: 0,
})
const importPollTimer = ref<ReturnType<typeof setTimeout>>()
let uploadAbortController: AbortController | undefined
let nextResumeEntryId = 0
let importRefreshVersion = 0
const uploadCompletedCount = computed(() => candidateResumeFiles.value.filter(item => ['queued', 'processing', 'completed'].includes(item.status)).length)
const uploadRetryCount = computed(() => candidateResumeFiles.value.filter(item => item.status === 'failed' && !item.analysisTaskId).length)
const uploadPendingCount = computed(() => candidateResumeFiles.value.filter(item => item.status === 'pending').length)
const uploadStarted = computed(() => !!activeImportBatchId.value)
const uploadButtonLabel = computed(() => {
  if (creatingCandidate.value) return '上传中（' + uploadCompletedCount.value + '/' + candidateResumeFiles.value.length + '）...'
  if (uploadRetryCount.value && !uploadPendingCount.value) return '重试失败文件（' + uploadRetryCount.value + '）'
  return candidateResumeFiles.value.length > 1 ? '上传并解析（' + (uploadPendingCount.value + uploadRetryCount.value) + '份）' : '上传并解析'
})

const importProgressLabel = computed(() => {
  const summary = importBatchSummary.value
  if (summary.phase === 'uploading') {
    return `文件上传：成功 ${summary.uploaded}/${summary.total}，${summary.uploadProcessing} 份处理中${summary.uploadFailed ? `，${summary.uploadFailed} 份失败` : ''}`
  }
  const analysis = [
    summary.queued ? `排队 ${summary.queued}` : '',
    summary.analyzing ? `分析中 ${summary.analyzing}` : '',
    `完成 ${summary.completed}/${summary.total}`,
    summary.analysisFailed ? `失败 ${summary.analysisFailed}` : '',
    summary.removed ? `已删除 ${summary.removed}` : '',
  ].filter(Boolean).join('，')
  return `${summary.phase === 'cancelled' ? '文件上传：已停止' : `文件上传：${summary.uploaded}/${summary.total} 已完成`}；AI 分析：${analysis}`
})

function updateImportSummary() {
  const entries = candidateResumeFiles.value
  const statuses = entries.map(entry => entry.status)
  const uploadFailed = entries.filter(entry => entry.status === 'failed' && !entry.analysisTaskId).length
  const analysisFailed = entries.filter(entry => entry.status === 'failed' && !!entry.analysisTaskId).length
  const removed = statuses.filter(status => status === 'removed').length
  const phase: ApiResumeImportBatchPhase = activeImportBatchPhase.value === 'cancelled'
    ? 'cancelled'
    : statuses.some(status => ['pending', 'uploading'].includes(status))
    ? 'uploading'
    : statuses.some(status => status === 'processing')
      ? 'analyzing'
      : statuses.some(status => status === 'queued')
        ? 'waiting_analysis'
        : uploadFailed || analysisFailed || removed
            ? 'completed_with_issues'
            : 'completed'
  importBatchSummary.value = {
    phase,
    total: entries.length,
    uploaded: statuses.filter(status => ['queued', 'processing', 'completed', 'failed', 'removed'].includes(status)).length,
    uploadFailed,
    uploadProcessing: statuses.filter(status => ['pending', 'uploading'].includes(status)).length,
    queued: statuses.filter(status => status === 'queued').length,
    analyzing: statuses.filter(status => status === 'processing').length,
    completed: statuses.filter(status => status === 'completed').length,
    analysisFailed,
    removed,
    cancelled: statuses.filter(status => status === 'cancelled').length,
    terminalAnalysis: statuses.filter(status => ['completed', 'failed', 'removed', 'cancelled'].includes(status)).length,
  }
}
function rememberBatch(batchId: string) {
  const previousBatchId = activeImportBatchId.value
  activeImportBatchId.value = batchId
  if (!batchId && !candidateResumeFiles.value.length) activeImportBatchPhase.value = ''
  if (batchId !== previousBatchId) dismissedImportBatchId.value = ''
  if (!batchId) stopImportPolling()
  try {
    if (batchId) window.localStorage.setItem(RESUME_IMPORT_BATCH_KEY, batchId)
    else forgetRememberedBatch(previousBatchId)
  } catch { /* local persistence is optional; the server still owns progress */ }
}
function forgetRememberedBatch(batchId: string) {
  try {
    if (window.localStorage.getItem(RESUME_IMPORT_BATCH_KEY) === batchId) window.localStorage.removeItem(RESUME_IMPORT_BATCH_KEY)
  } catch { /* storage may be disabled */ }
}
function reconcileImportTracking() {
  if (!hasActiveImportWork.value) {
    stopImportPolling()
    if (!uploadRetryCount.value) forgetRememberedBatch(activeImportBatchId.value)
  }
}
function replaceEntriesFromBatch(batch: Awaited<ReturnType<typeof getResumeImportBatch>>) {
  activeImportBatchStatus.value = batch.status
  activeImportBatchPhase.value = resumeImportBatchPhase(batch)
  candidateJobId.value = batch.jobId
  const previous = new Map(
    candidateResumeFiles.value.flatMap(item => [
      [item.serverItemId || `client:${item.id}`, item] as const,
      ...(item.clientFileId ? [[item.clientFileId, item] as const] : []),
    ]),
  )
  candidateResumeFiles.value = batch.items.map(item => {
    const prior = previous.get(item.id) || previous.get(item.clientFileId)
    const status = resumeImportItemStatus(item)
    return {
      id: prior?.id ?? ++nextResumeEntryId,
      ...(item.clientFileId ? { clientFileId: item.clientFileId } : {}),
      ...(prior?.file ? { file: prior.file } : {}),
      originalFilename: item.originalFilename,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      status,
      progress: status === 'uploading' ? 1 : ['queued', 'processing', 'completed'].includes(status) ? 100 : prior?.progress ?? 0,
      serverItemId: item.id,
      ...(item.candidateId ? { candidateId: item.candidateId } : {}),
      ...(item.applicationId ? { applicationId: item.applicationId } : {}),
      ...(item.analysisTaskId ? { analysisTaskId: item.analysisTaskId } : {}),
      ...(item.error ? { error: item.error } : {}),
    }
  })
  // A server-side upload summary can be complete while AI tasks are only queued.
  // Keep the derived stage attached to the displayed entries so local progress and
  // polling use the same source of truth.
  if (activeImportBatchPhase.value === 'waiting_analysis' || activeImportBatchPhase.value === 'analyzing') {
    activeImportBatchStatus.value = 'completed'
  }
  updateImportSummary()
  reconcileImportTracking()
}

function openResumeUpload() {
  if (creatingCandidate.value) return
  if (activeImportBatchId.value && activeImportBatchPhase.value !== 'uploading') {
    rememberBatch('')
    activeImportBatchStatus.value = ''
    activeImportBatchPhase.value = ''
    candidateResumeFiles.value = []
    candidateJobId.value = ''
    updateImportSummary()
  }
  uploadDialogError.value = ''
  showCreateCandidate.value = true
}
function viewImportProgress() {
  showCreateCandidate.value = true
}
function closeResumeUpload() {
  showCreateCandidate.value = false
}
function dismissImportProgress() {
  dismissedImportBatchId.value = activeImportBatchId.value
}
function removeResumeFile(id: number) {
  if (creatingCandidate.value) return
  candidateResumeFiles.value = candidateResumeFiles.value.filter(item => item.id !== id || ['queued', 'processing', 'completed'].includes(item.status))
  updateImportSummary()
}
function resumeUploadStatus(entry: ResumeUploadEntry) {
  if (entry.status === 'uploading') return entry.progress >= 100 ? '文件已发送 · 等待服务器确认' : `上传中 ${entry.progress}%`
  if (entry.status === 'failed') return entry.analysisTaskId ? 'AI 分析失败，可重试' : '上传失败'
  return {
    pending: '等待上传',
    uploading: `上传中 ${entry.progress}%`,
    queued: '已上传 · AI 分析排队中',
    processing: 'AI 正在分析',
    completed: 'AI 分析完成',
    failed: '上传失败',
    cancelled: '已取消',
    removed: '关联简历或分析任务已删除',
  }[entry.status]
}
function resumeFileSize(file: { size?: number; sizeBytes?: number }) {
  const size = file.size ?? file.sizeBytes ?? 0
  return size < 1024 * 1024 ? Math.max(1, Math.ceil(size / 1024)) + ' KB' : (size / (1024 * 1024)).toFixed(1) + ' MB'
}
const candidateJobId = ref('')
const creatingCandidate = ref(false)

const showCreateApplication = ref(false)
const applicationCandidateId = ref('')
const applicationTargetId = ref('')
function openApplication(row?: Awaited<ReturnType<typeof loadCandidates>>[number]) {
  if (operationBusy.value) return
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
let suspended = false
let activatedOnce = false

async function refresh(silent = false, afterOperation = false) {
  if (operationBusy.value && !afterOperation) return
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
  if (disposed || suspended) return
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

function stopImportPolling() {
  if (importPollTimer.value) clearTimeout(importPollTimer.value)
  importPollTimer.value = undefined
  importRefreshVersion += 1
}
function scheduleImportPolling(delay = 2000) {
  stopImportPolling()
  if (!activeImportBatchId.value || disposed || suspended || !hasActiveImportWork.value) return
  importPollTimer.value = setTimeout(() => {
    importPollTimer.value = undefined
    void refreshImportBatch(true)
  }, delay)
}
async function refreshImportBatch(scheduleNext = true) {
  const batchId = activeImportBatchId.value
  if (!batchId) return
  const version = ++importRefreshVersion
  try {
    const batch = await getResumeImportBatch(batchId)
    if (disposed || cancellingUpload.value || batchId !== activeImportBatchId.value || version !== importRefreshVersion) return
    replaceEntriesFromBatch(batch)
    if (scheduleNext && hasActiveImportWork.value) scheduleImportPolling(batch.items.some(item => item.status === 'queued' || item.status === 'pending_upload' || item.status === 'uploading') ? 5000 : 2000)
    if (batch.counts.completed > 0 && !creatingCandidate.value) await refresh(true)
  } catch (cause) {
    if (disposed || cancellingUpload.value || batchId !== activeImportBatchId.value || version !== importRefreshVersion) return
    if (cause instanceof ApiClientError && cause.status === 404) {
      rememberBatch('')
      activeImportBatchStatus.value = ''
      activeImportBatchPhase.value = ''
      candidateResumeFiles.value = []
      updateImportSummary()
      return
    }
    if (scheduleNext && !suspended) {
      stopImportPolling()
      importPollTimer.value = setTimeout(() => {
        importPollTimer.value = undefined
        void refreshImportBatch(true)
      }, 5000)
    }
    uploadDialogError.value = cause instanceof Error ? cause.message : '读取导入进度失败'
  }
}
async function refreshCandidatesAndImport() {
  await Promise.all([refresh(), refreshImportBatch()])
}
async function restoreActiveImportBatch() {
  let batchId = ''
  try { batchId = window.localStorage.getItem(RESUME_IMPORT_BATCH_KEY) || '' } catch { /* storage disabled */ }
  if (!batchId) return
  activeImportBatchId.value = batchId
  await refreshImportBatch()
}
async function cancelActiveImport() {
  if (cancellingUpload.value) return
  const batchId = activeImportBatchId.value
  if (!batchId && !uploadAbortController) return
  cancellingUpload.value = true
  stopImportPolling()
  uploadAbortController?.abort()
  activeImportBatchStatus.value = 'cancelled'
  activeImportBatchPhase.value = 'cancelled'
  for (const entry of candidateResumeFiles.value) {
    if (entry.status === 'pending' || entry.status === 'uploading') {
      entry.status = 'cancelled'
      entry.error = undefined
    }
  }
  updateImportSummary()
  uploadDialogError.value = '正在取消上传；已上传成功的简历会继续处理。'
  try {
    if (batchId) {
      const batch = await cancelResumeImportBatch(batchId)
      if (!disposed && batchId === activeImportBatchId.value) {
        replaceEntriesFromBatch(batch)
        uploadDialogError.value = '已停止剩余上传；已上传成功的简历会继续处理。'
      }
    }
  } catch (cause) {
    uploadDialogError.value = cause instanceof Error ? cause.message : '取消上传失败'
  } finally {
    cancellingUpload.value = false
  }
}
async function submitCreateCandidate() {
  if (creatingCandidate.value || cancellingUpload.value) return
  const pendingEntries = candidateResumeFiles.value.filter(item => ['pending', 'failed'].includes(item.status) && !item.analysisTaskId)
  const entries = pendingEntries.filter(item => item.file)
  if (!entries.length) {
    if (!candidateResumeFiles.value.length) uploadDialogError.value = '请选择简历文件'
    else if (pendingEntries.length) uploadDialogError.value = '待上传文件已失效，请重新选择对应简历文件后再上传'
    else uploadDialogError.value = '所选文件均已提交，无需重复上传'
    return
  }
  if (!candidateJobId.value) { uploadDialogError.value = '请选择简历对应岗位'; return }
  const jobId = candidateJobId.value
  const jobTitle = jobs.value.find(job => (job.entityId || job.id) === jobId)?.title || '所选岗位'
  creatingCandidate.value = true
  stopImportPolling()
  uploadDialogError.value = ''
  error.value = ''
  feedback.value = ''
  const controller = new AbortController()
  uploadAbortController = controller
  try {
    if (!activeImportBatchId.value) {
      const batch = await createResumeImportBatch({
        jobId,
        files: entries.map(entry => ({
          clientFileId: entry.clientFileId || `local-${entry.id}`,
          originalFilename: entry.originalFilename,
          mimeType: entry.mimeType,
          sizeBytes: entry.sizeBytes,
        })),
      })
      rememberBatch(batch.id)
      activeImportBatchStatus.value = batch.status
      const byClientId = new Map(batch.items.map(item => [item.clientFileId, item]))
      for (const entry of entries) {
        entry.clientFileId ||= `local-${entry.id}`
        entry.serverItemId = byClientId.get(entry.clientFileId)?.id
      }
      if (controller.signal.aborted || cancellingUpload.value) {
        rememberBatch(batch.id)
        activeImportBatchStatus.value = 'cancelled'
        await cancelResumeImportBatch(batch.id)
        return
      }
    }
    const batchId = activeImportBatchId.value
    if (!batchId) throw new Error('导入批次创建失败')
    rememberBatch(batchId)
    dismissedImportBatchId.value = ''
    await runResumeUploadQueue(entries, 3, async (entry) => {
      if (controller.signal.aborted || cancellingUpload.value) {
        entry.status = 'cancelled'
        entry.error = undefined
        updateImportSummary()
        return
      }
      entry.status = 'uploading'
      entry.progress = 1
      entry.error = undefined
      updateImportSummary()
      try {
        if (!entry.file || !entry.serverItemId) throw new Error('文件缺少上传标识，请重新选择文件')
        const content = await fileToBase64(entry.file, controller.signal)
        const uploaded = await uploadResumeImportItem(batchId, entry.serverItemId, content, {
          signal: controller.signal,
          onProgress: progress => { entry.progress = progress },
          onRetry: (attempt, delayMs, error) => {
            entry.error = `${error.message}${error.requestId ? `（请求编号 ${error.requestId}）` : ''}；${Math.ceil(delayMs / 1000)} 秒后重试（${attempt}/5）`
          },
        })
        entry.status = uploaded.status === 'queued' ? 'queued' : 'failed'
        entry.progress = 100
        entry.error = undefined
        entry.candidateId = uploaded.candidateId
        entry.applicationId = uploaded.applicationId
        entry.analysisTaskId = uploaded.analysisTaskId
      } catch (cause) {
        if (controller.signal.aborted || cancellingUpload.value) {
          entry.status = 'cancelled'
          entry.error = undefined
          return
        }
        entry.status = 'failed'
        entry.error = cause instanceof Error ? cause.message : '上传失败，请重试'
        throw cause
      } finally {
        updateImportSummary()
      }
    }, controller.signal)
    if (controller.signal.aborted || cancellingUpload.value) return
    void refresh(true)
    const submitted = entries.filter(entry => ['queued', 'processing', 'completed'].includes(entry.status)).length
    const failed = entries.filter(entry => entry.status === 'failed').length
    feedback.value = submitted ? '已提交 ' + submitted + ' 份简历并关联“' + jobTitle + '”，AI 正在后台并发解析和评分。' + (failed ? '另有 ' + failed + ' 份上传失败，可在窗口中重试。' : '') : ''
    if (failed) uploadDialogError.value = failed + ' 份简历上传失败，请查看各文件原因并重试；成功文件不会重复上传。'
    scheduleImportPolling(0)
  } catch (cause) {
    if (!controller.signal.aborted && activeImportBatchStatus.value !== 'cancelled') uploadDialogError.value = cause instanceof Error ? cause.message : '批次创建失败'
  } finally {
    creatingCandidate.value = false
    if (uploadAbortController === controller) uploadAbortController = undefined
    if (!disposed && activeImportBatchId.value) scheduleImportPolling(0)
  }
}
function resumeMimeType(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase()
  return ({ pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain', md: 'text/markdown' } as Record<string, string>)[extension || ''] || 'application/octet-stream'
}
function selectResumeFile(event: Event) {
  if (creatingCandidate.value || cancellingUpload.value) return
  const input = event.target as HTMLInputElement
  const rejected: string[] = []
  const accepted: File[] = []
  const existingKeys = new Set(candidateResumeFiles.value.map(item => `${item.originalFilename}\u0000${item.sizeBytes}\u0000${item.file?.lastModified ?? ''}`))
  for (const file of Array.from(input.files || [])) {
    if (/\.doc$/i.test(file.name)) { rejected.push(file.name + '：请转为 DOCX 或 PDF 后上传'); continue }
    if (!/\.(pdf|docx|txt|md)$/i.test(file.name)) { rejected.push(file.name + '：不支持此文件格式'); continue }
    if (!file.size) { rejected.push(file.name + '：文件为空'); continue }
    if (file.size > 10 * 1024 * 1024) { rejected.push(file.name + '：单份简历不能超过 10 MB'); continue }
    if (activeImportBatchId.value) {
      const restored = candidateResumeFiles.value.find(item =>
        item.serverItemId && !item.file && !item.analysisTaskId && ['pending', 'failed'].includes(item.status)
        && item.originalFilename === file.name && item.sizeBytes === file.size
        && item.mimeType === (file.type || resumeMimeType(file.name)))
      if (restored) {
        restored.file = file
        restored.error = undefined
        restored.progress = 0
        continue
      }
      if (!candidateResumeFiles.value.some(item => item.file === file
        || (item.file && item.originalFilename === file.name && item.sizeBytes === file.size && item.file.lastModified === file.lastModified))) {
        rejected.push(file.name + '：与待续传文件不匹配；新增简历请另开上传批次')
      }
      continue
    }
    const key = `${file.name}\u0000${file.size}\u0000${file.lastModified}`
    if (existingKeys.has(key)) continue
    existingKeys.add(key)
    accepted.push(file)
  }
  if (candidateResumeFiles.value.length + accepted.length > MAX_RESUME_FILES_PER_BATCH) {
    rejected.push(`单批次最多上传 ${MAX_RESUME_FILES_PER_BATCH} 份简历，请分批上传`)
    accepted.length = 0
  }
  for (const file of accepted) {
    candidateResumeFiles.value.push({
      id: ++nextResumeEntryId,
      clientFileId: `local-${nextResumeEntryId}`,
      file,
      originalFilename: file.name,
      mimeType: file.type || resumeMimeType(file.name),
      sizeBytes: file.size,
      status: 'pending',
      progress: 0,
    })
  }
  uploadDialogError.value = rejected.join('；')
  input.value = ''
  updateImportSummary()
}

function fileToBase64(file: File, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const abort = () => reader.abort()
    if (signal?.aborted) { reject(new DOMException('上传已取消', 'AbortError')); return }
    signal?.addEventListener('abort', abort, { once: true })
    const finish = (operation: () => void) => {
      signal?.removeEventListener('abort', abort)
      operation()
    }
    reader.onload = () => {
      if (typeof reader.result !== 'string') { finish(() => reject(new Error('读取文件失败'))); return }
      const dataUrl = reader.result
      const comma = dataUrl.indexOf(',')
      finish(() => resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl))
    }
    reader.onerror = () => finish(() => reject(reader.error ?? new Error('读取文件失败')))
    reader.onabort = () => finish(() => reject(new DOMException('上传已取消', 'AbortError')))
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

onMounted(() => {
  void refresh(true)
  void restoreActiveImportBatch()
})
onActivated(() => {
  suspended = false
  void nextTick(() => {
    const table = candidateTable.value?.$el as HTMLElement | undefined
    if (table) table.scrollLeft = tableScrollLeft
  })
  if (activatedOnce) {
    void refresh(true)
    if (activeImportBatchId.value) void refreshImportBatch()
  }
  activatedOnce = true
})
onDeactivated(() => {
  analysisRunVersion += 1
  suspended = true
  refreshVersion += 1
  if (progressTimer) clearTimeout(progressTimer)
  progressTimer = undefined
  stopImportPolling()
})
onUnmounted(() => {
  analysisRunVersion += 1
  disposed = true
  refreshVersion += 1
  uploadAbortController?.abort()
  if (progressTimer) clearTimeout(progressTimer)
  stopImportPolling()
})
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
  <div v-if="(hasActiveImportWork || uploadRetryCount) && activeImportBatchId !== dismissedImportBatchId && !showCreateCandidate" class="success-note resume-import-progress" role="status">
    <span>{{ importProgressLabel }}</span>
    <button class="btn btn-ghost" type="button" @click="viewImportProgress">查看进度</button>
    <button v-if="activeImportBatchStatus === 'uploading'" class="btn btn-ghost" type="button" @click="cancelActiveImport">取消上传</button>
    <button class="btn btn-ghost resume-dismiss-progress" type="button" aria-label="隐藏导入进度提示" title="隐藏提示，不会停止上传或解析" @click="dismissImportProgress"><X :size="16" aria-hidden="true" /></button>
  </div>

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
        <button class="resume-close" type="button" aria-label="关闭上传简历窗口" @click="closeResumeUpload">×</button>
      </div>
      <p class="resume-dialog-intro">上传后由系统在后台建立候选人档案并发起分析，可关闭页面稍后查看进度。</p>
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
              <small>支持 PDF、DOCX、TXT、Markdown，单份不超过 10 MB</small>
            </span>
            <span class="upload-box-action">{{ uploadStarted ? '重新选择' : candidateResumeFiles.length ? '继续添加' : '浏览文件' }}</span>
            <input id="candidate-resume-file" class="resume-file-input" type="file" multiple :disabled="creatingCandidate || cancellingUpload" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" @change="selectResumeFile">
          </label>
          <ul v-if="candidateResumeFiles.length" class="resume-file-list" aria-label="已选择的简历">
            <li v-for="entry in candidateResumeFiles" :key="entry.id" class="resume-file-row" :data-status="entry.status">
              <div class="resume-file-info"><strong :title="entry.originalFilename">{{ entry.originalFilename }}</strong><small>{{ resumeFileSize(entry) }} · {{ resumeUploadStatus(entry) }}</small><small v-if="entry.error" class="resume-file-error">{{ entry.error }}</small><small v-if="entry.status === 'failed' && entry.candidateId">候选人档案已创建，重试将复用，不会重复建档。</small></div>
              <button v-if="['pending', 'failed', 'cancelled'].includes(entry.status)" class="resume-remove" type="button" :disabled="creatingCandidate || cancellingUpload" :aria-label="'移除 ' + entry.originalFilename" @click="removeResumeFile(entry.id)">移除</button>
            </li>
          </ul>
          <small class="muted resume-note">可多选文件或继续添加；每份简历单独建立候选人档案，解析姓名、邮箱和电话。</small>
        </div>
        <div class="form-field resume-job-field">
          <label for="candidate-resume-job">对应岗位 <span class="required">*</span></label>
          <div class="resume-select-wrap">
            <select id="candidate-resume-job" v-model="candidateJobId" :disabled="creatingCandidate || uploadStarted || cancellingUpload" aria-label="上传简历岗位">
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
          <button class="btn btn-ghost" type="button" @click="closeResumeUpload">{{ creatingCandidate ? '收起' : uploadCompletedCount ? '完成' : '取消' }}</button>
          <button v-if="creatingCandidate || activeImportBatchStatus === 'uploading' || cancellingUpload" class="btn btn-ghost resume-cancel-upload" type="button" :disabled="cancellingUpload" @click="cancelActiveImport">{{ cancellingUpload ? '取消中...' : '取消上传' }}</button>
          <button class="btn btn-primary resume-submit" type="button" :disabled="creatingCandidate || (candidateResumeFiles.length > 0 && !uploadPendingCount && !uploadRetryCount)" @click="submitCreateCandidate"><span class="button-spark" aria-hidden="true">✦</span>{{ uploadButtonLabel }}</button>
        </div>
      </div>
    </div>
  </div>
  <ApplicationCreateDialog v-if="showCreateApplication" :candidates="rows" :jobs="jobs" :initial-candidate-id="applicationCandidateId" :initial-application-id="applicationTargetId" :can-arrange="canArrange" @arrange="arrangeApplication" @close="showCreateApplication = false" @changed="refresh(true)" @created="applicationCreated" @view="viewApplication" />
  <InitialInterviewDialog v-if="invitationApplicationId" :key="invitationApplicationId" :application-id="invitationApplicationId" @close="invitationApplicationId = ''" @created="interviewCreated" />

  <div v-if="feedback" class="success-note">{{ feedback }}</div>
  <div v-if="error" class="error-note">{{ error }}</div>
  <div v-if="batchDeleteFailures.length" class="error-note batch-delete-failures" role="alert">
    <strong>以下记录未删除</strong>
    <ul><li v-for="(failure, index) in batchDeleteFailures" :key="index">{{ failure }}</li></ul>
  </div>
  <div v-if="batchAnalysisNotes.length" class="batch-analysis-results" role="status">
    <strong>批量解析处理明细</strong>
    <ul><li v-for="(note, index) in batchAnalysisNotes" :key="index">{{ note }}</li></ul>
  </div>
  <div v-if="loading" class="loading-note">正在读取候选人...</div>
  <div class="filter-bar">
    <template v-if="!loading">
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
          <option value="none">更新时间最新</option>
          <option value="desc">评分从高到低</option>
          <option value="asc">评分从低到高</option>
        </select>
      </div>
      <div class="filter-field">
        <label for="candidate-job-sort">岗位排序</label>
        <select id="candidate-job-sort" v-model="jobSort" aria-label="岗位排序">
          <option value="none">更新时间最新</option>
          <option value="asc">岗位 A→Z</option>
          <option value="desc">岗位 Z→A</option>
        </select>
      </div>
    </template>
    <div class="candidate-actions">
      <button class="btn btn-ghost" type="button" @click="refreshCandidatesAndImport">刷新</button>
      <button class="btn btn-primary" type="button" :disabled="creatingCandidate || operationBusy" @click="showCreateApplication = false; openResumeUpload()">上传简历并建档</button>
      <button class="btn btn-primary" type="button" :disabled="creatingCandidate || operationBusy" @click="openApplication()">新建应聘申请</button>
      <label class="talent-filter"><input v-model="talentFilter" type="checkbox" />只看人才库</label>
    </div>
  </div>

  <div v-if="canDelete && !loading" class="batch-delete-toolbar">
    <span aria-live="polite">已选择 {{ selectedRows.length }} 条</span>
    <div class="batch-actions">
    <button class="btn btn-primary batch-analyze-button" type="button" :disabled="!selectedRows.length || operationBusy" @click="handleBatchAnalyze"><RefreshCw :size="16" aria-hidden="true" />{{ batchAnalyzing ? `提交中 ${batchAnalysisProgress}/${batchAnalysisTotal}` : '批量重新解析' }}</button>
    <button class="btn btn-ghost batch-delete-button" type="button" :disabled="!selectedRows.length || operationBusy" @click="handleBatchDelete"><Trash2 :size="16" aria-hidden="true" />{{ batchDeleting ? '批量删除中…' : '批量删除' }}</button>
    </div>
  </div>
  <CandidateTable
    v-if="!loading"
    ref="candidateTable"
    :rows="filteredRows"
    :can-delete="canDelete"
    :can-review="canDelete"
    :can-arrange="canArrange"
    :can-apply="canDelete"
    :deleting-id="deletingId"
    :deletion-busy="operationBusy"
    @selection-change="selectedRows = $event"
    @open="openDetail"
    @arrange="openArrange"
    @delete="handleDelete"
    @apply="openApplication" @analyze="openApplicationAnalysis"
    @review="openReview"
  />
</template>

<style scoped>
.batch-delete-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 10px; font-size: 13px; color: #64748b; }
.batch-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.batch-analyze-button { display: inline-flex; align-items: center; gap: 6px; min-width: 142px; justify-content: center; }
.batch-analysis-results { margin-bottom: 12px; padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; font-size: 13px; }
.batch-analysis-results ul { margin: 8px 0 0; padding-left: 20px; max-height: 180px; overflow-y: auto; overflow-wrap: anywhere; }
.batch-delete-button { display: inline-flex; align-items: center; gap: 6px; color: #b91c1c; border-color: #fecaca; }
.batch-delete-button:disabled { opacity: .5; cursor: not-allowed; }
.batch-delete-failures ul { margin: 8px 0 0; padding-left: 20px; max-height: 180px; overflow-y: auto; overflow-wrap: anywhere; }
.score-review-dialog { display: flex; flex-direction: column; width: min(920px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow: hidden; padding: 0; box-sizing: border-box; }
.review-dialog-head { display: flex; flex-shrink: 0; justify-content: space-between; align-items: center; gap: 12px; padding: 18px; background: #fff; border-bottom: 1px solid #e2e8f0; }
.review-dialog-head h3 { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.review-dialog-head button { flex-shrink: 0; border-color: #dc2626; color: #dc2626; background: #fff; }
.review-dialog-head button:hover { border-color: #b91c1c; color: #b91c1c; background: #fef2f2; }
.review-dialog-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 18px; }
.candidate-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; white-space: nowrap; }
.talent-filter { display: flex; align-items: center; gap: 8px; margin: 0 0 0 4px; font-size: 13px; color: #64748b; white-space: nowrap; }
.filter-bar {
  display: flex;
  flex-wrap: nowrap;
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
  .filter-bar { flex-wrap: wrap; }
  .search-field { flex-basis: 100%; }
  .filter-field { flex: 1 1 180px; }
  .candidate-actions { flex: 1 1 100%; min-width: 0; max-width: 100%; flex-wrap: wrap; white-space: normal; }
}
@media (max-width: 760px) {
  .filter-bar { align-items: stretch; padding: 10px; border-radius: 15px; }
  .search-field { flex-basis: 100%; }
  .filter-field { flex-basis: 240px; }
  .candidate-actions { min-width: 0; flex-wrap: wrap; white-space: normal; }
  .candidate-actions .talent-filter { margin-left: 0; }
}
.talent-filter input[type="checkbox"] { flex: 0 0 14px; width: 14px; height: 14px; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
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
.resume-file-row[data-status="processing"] { border-color: #c9ddf7; background: #f6faff; }
.resume-file-row[data-status="completed"] { border-color: #bce6d9; background: #f0fbf7; }
.resume-file-row[data-status="failed"] { border-color: #f3caca; background: #fffafa; }
.resume-file-row[data-status="cancelled"] { border-color: #e2e8f0; background: #f8fafc; opacity: .78; }
.resume-file-info .resume-file-error { color: #b91c1c; }
.resume-remove { flex: 0 0 auto; padding: 4px 6px; background: transparent; border: 0; color: #8e6370; font-size: 11px; cursor: pointer; }
.resume-remove:disabled, .resume-close:disabled { cursor: not-allowed; opacity: .5; }
.resume-import-progress { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.resume-import-progress .btn { padding: 5px 9px; }
.resume-import-progress > span { flex: 1; }
.resume-import-progress .resume-dismiss-progress { display: inline-flex; align-items: center; justify-content: center; }
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
