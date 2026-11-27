<script setup lang="ts">
import { formatAnalysisError } from '../../../shared/utils/analysis-error'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { prepareInterviewQuestions } from '../api/question-preparation'
import { useRoute, useRouter } from 'vue-router'
import {
  completeInterview,
  deleteInterview,
  createInterview,
  INTERVIEW_TYPE_LABEL,
  loadInterviewScheduleData,
  loadInterviews,
  updateInterviewSchedule,
  type ApiApplication,
  type InterviewScheduleData,
  type InterviewType,
  type InterviewView,
  type InterviewerOption,
  type InterviewSheetType,
  type ScheduleCandidate,
  type ScheduleJob,
} from '../api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { navigateToOffer } from '../utils/offer-navigation'
import { normalizeSearchText } from '../../../shared/utils/search'
import PageHeader from '../../../shared/components/PageHeader.vue'
import PageFeedback from '../../../shared/components/workflow/PageFeedback.vue'
import InterviewTable from '../components/InterviewTable.vue'
import { aiScoreLabel, interviewResult, INTERVIEW_RESULT_LABELS, isFinalInterview } from '../utils/interview-result'

const rows = ref<InterviewView[]>([])
const completedOfferApplicationId = ref('')
async function openCompletedOffer() {
  if (!completedOfferApplicationId.value) return
  if (!await navigateToOffer(router, completedOfferApplicationId.value)) feedback.value = '面试结论已保存，跳转未完成，请点击前往 Offer 管理重试'
}
const preparingInterviewId = ref<string | null>(null)
let preparationTimer: ReturnType<typeof setTimeout> | undefined
let preparationDisposed = false
function schedulePreparationRefresh() {
  if (preparationTimer) clearTimeout(preparationTimer)
  if (preparationDisposed || !rows.value.some(row => ['queued', 'generating'].includes(row.questionPreparation?.status ?? ''))) return
  preparationTimer = setTimeout(async () => {
    try {
      const latest = await loadInterviews()
      const updated = new Map(latest.map(row => [row.entityId, row]))
      if (!preparationDisposed) rows.value = rows.value.map(row => {
        const refreshed = updated.get(row.entityId)
        return refreshed ? { ...row, ...refreshed, questionPreparation: refreshed.questionPreparation } : row
      })
    } catch { /* Keep current data and retry quietly; normal refresh reports list failures. */ }
    finally { schedulePreparationRefresh() }
  }, 8000)
}
async function prepareQuestions(row: InterviewView) {
  if (preparingInterviewId.value) return
  preparingInterviewId.value = row.entityId
  try {
    const preparation = await prepareInterviewQuestions(row.entityId)
    if (preparationDisposed) return
    row.questionPreparation = preparation
    if (preparation.status === 'failed' || preparation.status === 'cancelled') {
      feedback.value = ''
      error.value = preparation.error ? formatAnalysisError(preparation.error) : '该面试已结束或取消，不再准备面试表。'
    } else {
      error.value = ''
      feedback.value = preparation.status === 'ready' ? '面试表已就绪' : '已开始后台准备面试表，无需停留在当前页面'
    }
    schedulePreparationRefresh()
  } catch (cause) { if (!preparationDisposed) error.value = describeApiFailure(cause, '提交面试表准备任务失败').message }
  finally { preparingInterviewId.value = null }
}
onUnmounted(() => { preparationDisposed = true; if (preparationTimer) clearTimeout(preparationTimer) })
const loading = ref(true)
const loadFailed = ref(false)
const error = ref('')
const feedback = ref('')
const acting = ref(false)
const confirmingDeleteId = ref<string | null>(null)
const deletingInterviewId = ref<string | null>(null)
const searchQuery = ref('')
const jobFilter = ref('')
const statusFilter = ref('')
const roundFilter = ref('')
const interviewerFilter = ref('')
const jobSort = ref<'none' | 'asc' | 'desc'>('none')
const feedbackStatusLabels = INTERVIEW_RESULT_LABELS
const jobOptions = computed(() => [...new Set(rows.value.map((row) => row.job).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')))
const roundOptions = computed(() => [...new Set(rows.value.map((row) => row.round).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })))
const interviewerOptions = computed(() => [...new Set(rows.value.flatMap((row) => row.interviewers).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')))
const filteredRows = computed(() => {
  const query = normalizeSearchText(searchQuery.value.trim())
  const matching = rows.value.filter((row) =>
    (!jobFilter.value || row.job === jobFilter.value)
    && (!statusFilter.value || interviewResult(row) === statusFilter.value)
    && (!roundFilter.value || row.round === roundFilter.value)
    && (!interviewerFilter.value || row.interviewers.includes(interviewerFilter.value))
    && (!query || [row.candidate, row.job, row.id, row.round, row.scheduledAt, feedbackStatusLabels[interviewResult(row)], ...row.interviewers]
      .map(normalizeSearchText).join(' ').includes(query)))
  if (jobSort.value !== 'none') {
    matching.sort((a, b) => jobSort.value === 'asc' ? a.job.localeCompare(b.job, 'zh-CN') : b.job.localeCompare(a.job, 'zh-CN'))
  }
  return matching
})
const hasFilters = computed(() => Boolean(searchQuery.value || jobFilter.value || statusFilter.value || roundFilter.value || interviewerFilter.value || jobSort.value !== 'none'))
function runSearch() { searchQuery.value = searchQuery.value.trim() }
function resetFilters() {
  searchQuery.value = ''; jobFilter.value = ''; statusFilter.value = ''
  roundFilter.value = ''; interviewerFilter.value = ''; jobSort.value = 'none'
}

const candidates = ref<ScheduleCandidate[]>([])
const jobs = ref<ScheduleJob[]>([])
const applications = ref<ApiApplication[]>([])
const interviewers = ref<InterviewerOption[]>([])
const candidateSearch = ref('')
const router = useRouter()
const route = useRoute()
const arrangingApplicationId = ref('')
const arrangingInterviewId = ref('')
const reschedulingInterviewId = ref('')
const scheduleLoading = ref(false)
const scheduleError = ref('')
let scheduleVersion = 0

const invitationMode = ref<'online' | 'offline'>('online')
const initialInvitation = computed(() => route.query.stage === 'initial' && !!arrangingApplicationId.value)
const rescheduleTarget = computed(() => rows.value.find((row) => row.entityId === reschedulingInterviewId.value) ?? null)
const rescheduling = computed(() => Boolean(reschedulingInterviewId.value))
const creatingInterview = computed(() => initialInvitation.value || rescheduling.value)
const scheduleStage = computed<'initial' | 'final'>(() => {
  if (rescheduling.value && rescheduleTarget.value) return isFinalInterview(rescheduleTarget.value) ? 'final' : 'initial'
  return initialInvitation.value ? 'initial' : 'final'
})
const showArrange = ref(false)
const arrangeForm = ref({
  candidateId: '',
  jobId: '',
  title: '',
  type: 'technical' as InterviewType,
  scheduledAt: '',
  location: '',
  meetingUrl: '',
  interviewerIds: [] as string[], leadId: '', sheetOwners: {} as Partial<Record<InterviewSheetType, string>>,
})

const interviewerSearch = ref('')
const filteredInterviewers = computed(() => interviewers.value.filter(person => normalizeSearchText(person.displayName + ' ' + (person.email ?? '')).includes(normalizeSearchText(interviewerSearch.value))))
const selectedInterviewers = computed(() => interviewers.value.filter(person => arrangeForm.value.interviewerIds.includes(person.id)))
const scheduleSheets = computed(() => scheduleStage.value === 'initial'
  ? [{ type: 'hr_screen' as InterviewSheetType, label: '人事面试表' }, { type: 'hiring_department' as InterviewSheetType, label: '用人部门面试表' }]
  : [{ type: 'business' as InterviewSheetType, label: '业务面试表' }, { type: 'hr' as InterviewSheetType, label: 'HR 面试表' }, { type: 'boss' as InterviewSheetType, label: 'BOSS 面试表' }])
watch(() => [...arrangeForm.value.interviewerIds], ids => {
  if (!ids.includes(arrangeForm.value.leadId)) arrangeForm.value.leadId = ids[0] ?? ''
  for (const sheet of scheduleSheets.value) {
    if (!ids.includes(arrangeForm.value.sheetOwners[sheet.type] ?? '')) arrangeForm.value.sheetOwners[sheet.type] = ids[0] ?? ''
  }
})
function restoreResponsibilities(target?: InterviewView | null) {
  interviewerSearch.value = ''
  arrangeForm.value.interviewerIds = (target?.interviewerIds ?? []).filter(id => interviewers.value.some(person => person.id === id))
  arrangeForm.value.leadId = target?.participants?.find(person => person.lead)?.userId ?? arrangeForm.value.interviewerIds[0] ?? ''
  arrangeForm.value.sheetOwners = Object.fromEntries(scheduleSheets.value.map(sheet => [sheet.type,
    target?.participants?.find(person => person.sheetTypes?.includes(sheet.type))?.userId ?? arrangeForm.value.leadId]))
}

const showConclude = ref(false)
const concludeError = ref('')
const concludeTarget = ref<InterviewView | null>(null)
const concludeOutcome = ref<'continue' | 'offer' | 'reject' | 'cancelled'>('continue')
const concludeFinal = computed(() => concludeTarget.value ? isFinalInterview(concludeTarget.value) : false)

const interviewTypes = computed(() => Object.entries(INTERVIEW_TYPE_LABEL).map(([value, label]) => ({ value, label })))
function candidateLabel(candidate: ScheduleCandidate): string {
  return `${candidate.fullName}（${candidate.code}）`
}

const filteredCandidates = computed(() => {
  const keyword = candidateSearch.value.trim().toLowerCase()
  if (!keyword) return candidates.value.slice(0, 12)
  return candidates.value.filter((candidate) => [candidate.fullName, candidate.code, candidate.email ?? ''].some((value) => value.toLowerCase().includes(keyword)))
})
const selectedCandidate = computed(() => candidates.value.find((candidate) => candidate.id === arrangeForm.value.candidateId))
const selectedJob = computed(() => jobs.value.find((job) => job.id === arrangeForm.value.jobId))
const existingApplication = computed(() => applications.value.find((application) => arrangingApplicationId.value
  ? application.id === arrangingApplicationId.value
  : false))
const pendingFinalInterviews = computed(() => rows.value.filter((row) => {
  const isFinal = row.stage === 'final' || (!row.stage && Number.parseInt(row.round, 10) >= 2)
  const missingStart = row.scheduledStartAt === undefined ? row.scheduledAt === '待安排' : !row.scheduledStartAt
  return isFinal && row.status === 'scheduled' && (missingStart || !row.interviewerIds.length)
}))
const selectedFinalInterview = computed(() => pendingFinalInterviews.value.find((row) => row.entityId === arrangingInterviewId.value) ?? null)

function clearFlags() { error.value = ''; feedback.value = '' }

async function refresh({ silent = false }: { silent?: boolean } = {}) {
  if (!silent) {
    loading.value = true
    clearFlags()
  }
  try {
    rows.value = await loadInterviews()
    loadFailed.value = false
  } catch (cause) {
    if (!silent) {
      loadFailed.value = true
    }
    error.value = describeApiFailure(cause, '读取面试失败').message
  } finally {
    if (!silent) loading.value = false
    schedulePreparationRefresh()
  }
}
function refreshFromUi() { void refresh() }

async function openArrange(applicationId = '', interviewId = '', reschedule = false) {
  if (acting.value) return
  const version = ++scheduleVersion
  clearFlags()
  scheduleError.value = ''
  arrangingApplicationId.value = applicationId
  arrangingInterviewId.value = ''
  reschedulingInterviewId.value = reschedule ? interviewId : ''
  invitationMode.value = 'online'
  candidateSearch.value = ''
  arrangeForm.value = { candidateId: '', jobId: '', title: '', type: 'technical', scheduledAt: '', location: '', meetingUrl: '', interviewerIds: [] as string[], leadId: '', sheetOwners: {} as Partial<Record<InterviewSheetType, string>> }
  showArrange.value = true
  scheduleLoading.value = true
  try {
    const [options, latestRows]: [InterviewScheduleData, InterviewView[]] = await Promise.all([loadInterviewScheduleData(), loadInterviews()])
    if (version !== scheduleVersion) return
    rows.value = latestRows
    candidates.value = options.candidates
    jobs.value = options.jobs
    applications.value = options.applications
    interviewers.value = options.interviewers
    if (reschedule) {
      const target = rows.value.find((row) => row.entityId === interviewId && row.applicationId === applicationId && row.status === 'cancelled')
      if (!target) throw new Error('未找到已取消的面试记录，请刷新面试列表后重试。')
      const application = applications.value.find((item) => item.id === applicationId)
      const candidate = application && candidates.value.find((item) => item.id === application.candidateId)
      const job = application && jobs.value.find((item) => item.id === application.jobId)
      if (!application || !candidate || !job) throw new Error('该面试关联的申请、候选人或岗位不可用，请刷新后重试。')
      if (application.status !== 'interviewing') throw new Error('该申请已不在待面试阶段，请刷新面试列表确认最新状态。')
      arrangeForm.value.candidateId = application.candidateId
      arrangeForm.value.jobId = application.jobId
      arrangeForm.value.title = target.title || (isFinalInterview(target) ? '复试' : '初试')
      arrangeForm.value.type = target.type ?? 'technical'
      candidateSearch.value = candidateLabel(candidate)
      restoreResponsibilities(target)
      invitationMode.value = target.location && !target.meetingUrl ? 'offline' : 'online'
    } else if (route.query.stage === 'initial' && applicationId && !interviewId) {
      const application = applications.value.find((item) => item.id === applicationId)
      if (!application) throw new Error('未找到该申请或无权访问，请返回简历库刷新后重试。')
      const candidate = candidates.value.find((item) => item.id === application.candidateId)
      const job = jobs.value.find((item) => item.id === application.jobId)
      if (!candidate || !job) throw new Error('该申请的候选人或岗位不可用，请返回简历库核查。')
      if (application.status !== 'interviewing') throw new Error('该申请已不在待面试阶段，请返回简历库确认最新状态。')
      arrangeForm.value.candidateId = application.candidateId
      arrangeForm.value.jobId = application.jobId
      candidateSearch.value = candidateLabel(candidate)
      if (initialInvitation.value) arrangeForm.value.title = '初试'
    } else {
      const pending = pendingFinalInterviews.value
      const target = interviewId
        ? pending.find((row) => row.entityId === interviewId && (!applicationId || row.applicationId === applicationId))
        : applicationId
          ? pending.find((row) => row.applicationId === applicationId)
          : pending[0]
      if (!target && (interviewId || applicationId)) throw new Error('未找到该候选人待安排的复试，请刷新面试列表确认最新状态。')
      arrangingInterviewId.value = target?.entityId ?? ''
      syncFinalInterviewSelection()
    }
  } catch (cause) {
    if (version === scheduleVersion) scheduleError.value = describeApiFailure(cause, '读取申请失败').message
  } finally {
    if (version === scheduleVersion) scheduleLoading.value = false
  }
}

function closeArrange() {
  if (acting.value) return
  scheduleVersion += 1
  scheduleLoading.value = false
  showArrange.value = false
  arrangingApplicationId.value = ''
  arrangingInterviewId.value = ''
  reschedulingInterviewId.value = ''
  clearApplicationQuery()
}

function clearApplicationQuery() {
  if (!route.query.applicationId) return
  const { applicationId: _applicationId, stage: _stage, interviewId: _interviewId, ...query } = route.query
  void router.replace({ query })
}

function syncCandidateFromSearch() {
  const selected = candidates.value.find((candidate) => candidateLabel(candidate) === candidateSearch.value.trim())
  arrangeForm.value.candidateId = selected?.id ?? ''
  if (!selected) arrangeForm.value.jobId = ''
}

function syncFinalInterviewSelection() {
  const selected = selectedFinalInterview.value
  restoreResponsibilities(selected)
  const start = selected?.scheduledStartAt ? new Date(selected.scheduledStartAt) : null
  const pad = (part: number) => String(part).padStart(2, '0')
  arrangeForm.value.scheduledAt = start && Number.isFinite(start.getTime())
    ? `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}` : ''
  arrangeForm.value.location = selected?.location || ''
  arrangeForm.value.meetingUrl = selected?.meetingUrl || ''
  invitationMode.value = selected?.location && !selected.meetingUrl ? 'offline' : 'online'
}

async function submitArrange() {
  if (acting.value || scheduleLoading.value || scheduleError.value) return
  const form = arrangeForm.value
  const wasInitialInvitation = initialInvitation.value
  const isRescheduling = rescheduling.value
  const cancelledInterview = rescheduleTarget.value
  const finalInterview = selectedFinalInterview.value
  const stageLabel = scheduleStage.value === 'initial' ? '初试' : '复试'
  if (creatingInterview.value && !form.candidateId.trim()) { error.value = '未找到简历库中的候选人'; return }
  if (creatingInterview.value && !form.jobId.trim()) { error.value = '未找到该候选人申请的岗位'; return }
  if (creatingInterview.value) {
    if (isRescheduling && !cancelledInterview) { error.value = '原面试记录不存在或已变更，请刷新后重试。'; return }
    if (!form.scheduledAt) { error.value = `请选择${stageLabel}开始时间`; return }
    if (invitationMode.value === 'online' && !form.meetingUrl.trim()) { error.value = `请填写线上${stageLabel}会议链接`; return }
    if (invitationMode.value === 'offline' && !form.location.trim()) { error.value = `请填写线下${stageLabel}地点`; return }
  } else {
    if (!finalInterview) { error.value = '请选择一条通过初试、待安排的复试记录'; return }
    if (!form.scheduledAt) { error.value = '请选择复试开始时间'; return }
    if (invitationMode.value === 'online' && !form.meetingUrl.trim()) { error.value = '请填写线上复试会议链接'; return }
    if (invitationMode.value === 'offline' && !form.location.trim()) { error.value = '请填写线下复试地点'; return }
  }
  if (creatingInterview.value && !form.title.trim()) form.title = stageLabel
  const selectedPeople = selectedInterviewers.value
  if (!selectedPeople.length || selectedPeople.length !== form.interviewerIds.length) { error.value = '请至少选择一名有效面试官'; return }
  if (!form.interviewerIds.includes(form.leadId)) { error.value = '请选择面试负责人'; return }
  if (scheduleSheets.value.some(sheet => !form.interviewerIds.includes(form.sheetOwners[sheet.type] ?? ''))) { error.value = '请为每张面试表指定评分人'; return }
  const assignedParticipants = selectedPeople.map(person => ({ userId: person.id, name: person.displayName,
    role: 'interviewer' as const, required: true, lead: person.id === form.leadId,
    sheetTypes: scheduleSheets.value.filter(sheet => form.sheetOwners[sheet.type] === person.id).map(sheet => sheet.type) }))

  acting.value = true
  clearFlags()
  try {
    const scheduledStartAt = new Date(form.scheduledAt).toISOString()
    if (creatingInterview.value) {
      if (!existingApplication.value || existingApplication.value.status !== 'interviewing') {
        throw new Error('原申请已不可安排面试，请返回简历库刷新后重试。')
      }
      const supportParticipants = (cancelledInterview?.participants ?? []).filter((person) => (person.role ?? 'interviewer') !== 'interviewer')
      await createInterview({
        applicationId: existingApplication.value.id,
        round: cancelledInterview ? Number.parseInt(cancelledInterview.round, 10) : 1,
        type: form.type,
        title: form.title.trim() || stageLabel,
        scheduledStartAt,
        location: invitationMode.value === 'offline' ? form.location.trim() : undefined,
        meetingUrl: invitationMode.value === 'online' ? form.meetingUrl.trim() : undefined,
        participants: [...supportParticipants, ...assignedParticipants],
      })
    } else {
      const supportParticipants = (finalInterview!.participants ?? []).filter((person) => (person.role ?? 'interviewer') !== 'interviewer')
      await updateInterviewSchedule(finalInterview!.entityId, {
        scheduledStartAt,
        location: invitationMode.value === 'offline' ? form.location.trim() : null,
        meetingUrl: invitationMode.value === 'online' ? form.meetingUrl.trim() : null,
        participants: [...supportParticipants, ...assignedParticipants],
      })
    }
    showArrange.value = false
    arrangingApplicationId.value = ''
    arrangingInterviewId.value = ''
    reschedulingInterviewId.value = ''
    clearApplicationQuery()
    candidateSearch.value = ''
    arrangeForm.value = { candidateId: '', jobId: '', title: '', type: 'technical', scheduledAt: '', location: '', meetingUrl: '', interviewerIds: [] as string[], leadId: '', sheetOwners: {} as Partial<Record<InterviewSheetType, string>> }
    await refresh()
    feedback.value = isRescheduling ? `${stageLabel}已重新安排，原取消记录已保留` : wasInitialInvitation ? '初试邀约已创建' : '复试已安排'
  } catch (cause) {
    error.value = describeApiFailure(cause, '安排面试失败').message
  } finally {
    acting.value = false
  }
}

function openConclude(row: InterviewView) {
  if (acting.value) return
  clearFlags()
  concludeError.value = ''
  concludeTarget.value = row
  concludeOutcome.value = isFinalInterview(row) ? 'offer' : 'continue'
  showConclude.value = true
}

function openReschedule(row: InterviewView) {
  if (row.status === 'cancelled') void openArrange(row.applicationId, row.entityId, true)
}

function askDeleteInterview(row: InterviewView) {
  clearFlags()
  confirmingDeleteId.value = row.entityId
}

function cancelDeleteInterview() {
  if (deletingInterviewId.value) return
  confirmingDeleteId.value = null
}

async function removeInterview(row: InterviewView) {
  if (deletingInterviewId.value || confirmingDeleteId.value !== row.entityId) return
  deletingInterviewId.value = row.entityId
  clearFlags()
  try {
    await deleteInterview(row.entityId)
    confirmingDeleteId.value = null
    await refresh()
    feedback.value = `已删除 ${row.candidate} 的面试记录`
  } catch (cause) {
    error.value = describeApiFailure(cause, '删除面试失败').message
  } finally {
    deletingInterviewId.value = null
  }
}

async function submitConclude() {
  if (acting.value || !concludeTarget.value) return
  const target = concludeTarget.value
  const outcome = concludeOutcome.value
  acting.value = true
  clearFlags()
  concludeError.value = ''
  try {
    await completeInterview(target.entityId, outcome)
    const outcomeLabel = outcome === 'offer' ? '通过，进入 Offer 阶段' : outcome === 'reject' ? '未通过' : outcome === 'cancelled' ? '已取消，保留面试记录' : '进入下一轮'
    rows.value = rows.value.map((row) => row.entityId === target.entityId
      ? { ...row, status: outcome === 'cancelled' ? 'cancelled' : 'completed', outcome, feedbackStatus: 'completed' }
      : row)
    showConclude.value = false
    concludeTarget.value = null
    if (outcome === 'offer') {
      completedOfferApplicationId.value = target.applicationId
      feedback.value = `${target.candidate} 面试已完成：${outcomeLabel}`
      await openCompletedOffer()
      return
    }
    await refresh({ silent: true })
    feedback.value = `${target.candidate} 面试已完成：${outcomeLabel}`
  } catch (cause) {
    const failure = describeApiFailure(cause, '完成面试失败，请稍后重试')
    concludeError.value = failure.message
  } finally {
    acting.value = false
  }
}

onMounted(async () => {
  await refresh()
  if (typeof route.query.applicationId === 'string') await openArrange(route.query.applicationId, typeof route.query.interviewId === 'string' ? route.query.interviewId : '')
})
watch(() => [route.query.applicationId, route.query.stage, route.query.interviewId], ([applicationId, , interviewId]) => {
  if (typeof applicationId === 'string') void openArrange(applicationId, typeof interviewId === 'string' ? interviewId : '')
})
</script>

<template>
  <PageHeader title="面试中心">
    <div class="inline-actions">
      <button class="btn btn-primary" type="button" @click="openArrange()">安排面试</button>
      <button class="btn btn-ghost" type="button" @click="refreshFromUi">刷新</button>
    </div>
  </PageHeader>

  <PageFeedback :feedback="feedback" :error="error" @clear-feedback="feedback = ''" @clear-error="error = ''" />
  <button v-if="completedOfferApplicationId" class="btn btn-primary" type="button" @click="openCompletedOffer">前往 Offer 管理</button>
  <section v-if="!loading && !loadFailed" class="interview-filters" aria-label="面试搜索与筛选">
    <form class="search-field" role="search" @submit.prevent="runSearch">
      <input v-model="searchQuery" type="search" aria-label="面试中心搜索" placeholder="搜索候选人、岗位、面试官、面试编号" />
      <button class="btn btn-ghost" type="submit">搜索</button>
    </form>
    <div class="filter-field">
      <label for="interview-job-filter">岗位筛选</label>
      <select id="interview-job-filter" v-model="jobFilter">
        <option value="">全部岗位</option>
        <option v-for="job in jobOptions" :key="job" :value="job">{{ job }}</option>
      </select>
    </div>
    <div class="filter-field">
      <label for="interview-status-filter">面试结果</label>
      <select id="interview-status-filter" v-model="statusFilter">
        <option value="">全部结果</option>
        <option v-for="(label, status) in feedbackStatusLabels" :key="status" :value="status">{{ label }}</option>
      </select>
    </div>
    <div class="filter-field">
      <label for="interview-round-filter">面试轮次</label>
      <select id="interview-round-filter" v-model="roundFilter">
        <option value="">全部轮次</option>
        <option v-for="round in roundOptions" :key="round" :value="round">{{ round }}</option>
      </select>
    </div>
    <div class="filter-field">
      <label for="interview-interviewer-filter">面试官</label>
      <select id="interview-interviewer-filter" v-model="interviewerFilter">
        <option value="">全部面试官</option>
        <option v-for="interviewer in interviewerOptions" :key="interviewer" :value="interviewer">{{ interviewer }}</option>
      </select>
    </div>
    <div class="filter-field">
      <label for="interview-job-sort">列表排序</label>
      <select id="interview-job-sort" v-model="jobSort">
        <option value="none">时间从新到旧</option>
        <option value="asc">岗位 A→Z</option>
        <option value="desc">岗位 Z→A</option>
      </select>
    </div>
    <div class="filter-summary">
      <span role="status" aria-live="polite">显示 <strong>{{ filteredRows.length }}</strong> / {{ rows.length }} 场面试</span>
      <button v-if="hasFilters" class="btn btn-ghost" type="button" @click="resetFilters">清除筛选</button>
    </div>
  </section>
  <div v-if="loading" class="loading-note">正在读取面试...</div>
  <div v-else-if="loadFailed" class="load-failure" role="status">
    <p>面试列表加载失败，请重试。</p>
    <button class="btn btn-primary" type="button" @click="refreshFromUi">重新加载</button>
  </div>
  <InterviewTable
    v-else
    :rows="filteredRows"
    :preparing-interview-id="preparingInterviewId"
    @prepare="prepareQuestions"
    :empty-message="hasFilters ? '没有符合条件的面试，请调整搜索关键词或清除筛选' : undefined"
    :confirming-delete-id="confirmingDeleteId"
    :deleting-interview-id="deletingInterviewId"
    @arrange="openArrange($event.applicationId, $event.entityId)"
    @reschedule="openReschedule"
    @conclude="openConclude"
    @detail="router.push(`/interviews/${$event.entityId}`)"
    @delete="askDeleteInterview"
    @confirm-delete="removeInterview"
    @cancel-delete="cancelDeleteInterview"
  />

  <div v-if="showArrange" class="overlay" role="presentation" @click.self="closeArrange">
    <div class="dialog arrange-dialog" role="dialog" aria-modal="true">
      <h3>{{ rescheduling ? `重新安排${scheduleStage === 'initial' ? '初试' : '复试'}` : initialInvitation ? '初试邀约' : '安排复试' }}</h3>
      <p v-if="rescheduling" class="muted">将创建一条新的面试安排，原取消记录会继续保留。</p>
      <p v-else-if="initialInvitation" class="muted">正在使用简历筛选通过的原申请，请补充面试信息，不会重新创建申请或重置评分。</p>
      <div v-if="scheduleLoading" role="status">正在读取申请与面试官…</div>
      <div v-if="scheduleError" class="error-note" role="alert">{{ scheduleError }} <button class="btn btn-ghost" type="button" @click="openArrange(arrangingApplicationId, arrangingInterviewId, rescheduling)">重试</button></div>
      <div v-if="error" class="error-note" role="alert">{{ error }}</div>
      <fieldset class="form-grid schedule-fields" :disabled="scheduleLoading || acting || !!scheduleError">
        <div v-if="creatingInterview" class="form-field candidate-search-field">
          <label>候选人（简历库）</label>
          <input v-model="candidateSearch" :disabled="!!arrangingApplicationId || scheduleLoading" list="schedule-candidate-options" placeholder="输入候选人姓名或编号搜索" @input="syncCandidateFromSearch" />
          <datalist id="schedule-candidate-options">
            <option v-for="candidate in filteredCandidates" :key="candidate.id" :value="candidateLabel(candidate)" />
          </datalist>
          <small v-if="!filteredCandidates.length">没有匹配的简历库候选人</small>
        </div>
        <div v-else class="form-field">
          <label for="final-interview-select">待安排的复试</label>
          <select id="final-interview-select" v-model="arrangingInterviewId" :disabled="scheduleLoading || !pendingFinalInterviews.length" @change="syncFinalInterviewSelection">
            <option value="" disabled>选择已通过初试的候选人</option>
            <option v-for="row in pendingFinalInterviews" :key="row.entityId" :value="row.entityId">{{ row.candidate }} · {{ row.job }} · {{ row.round }}</option>
          </select>
          <small v-if="!pendingFinalInterviews.length && !scheduleLoading">暂无通过初试且待安排复试的候选人</small>
        </div>
        <div v-if="creatingInterview" class="form-field">
          <label>岗位</label>
          <select v-model="arrangeForm.jobId" aria-label="岗位" :disabled="!arrangeForm.candidateId || !!arrangingApplicationId || scheduleLoading">
            <option value="" disabled>选择岗位</option>
            <option v-for="job in jobs" :key="job.id" :value="job.id">{{ job.title }}（{{ job.code }}）</option>
          </select>
          <small v-if="selectedJob && existingApplication">该候选人已有此岗位申请，将复用现有申请。</small>
        </div>
        <div v-if="creatingInterview" class="form-field"><label>面试标题</label><input v-model="arrangeForm.title" :placeholder="scheduleStage === 'initial' ? '初试' : '复试'" /></div>
        <div v-if="creatingInterview" class="form-field">
          <label>面试类型</label>
          <select v-model="arrangeForm.type"><option v-for="t in interviewTypes" :key="t.value" :value="t.value">{{ t.label }}</option></select>
        </div>
        <div class="form-field"><label>开始时间</label><input v-model="arrangeForm.scheduledAt" type="datetime-local" /></div>
        <div class="form-field"><label>{{ scheduleStage === 'initial' ? '初试方式' : '复试方式' }}</label><select v-model="invitationMode" :aria-label="scheduleStage === 'initial' ? '初试方式' : '复试方式'"><option value="online">线上面试</option><option value="offline">线下面试</option></select></div>
        <div v-if="invitationMode === 'offline'" class="form-field"><label>面试地点</label><input v-model="arrangeForm.location" placeholder="线下地点" /></div>
        <div v-if="invitationMode === 'online'" class="form-field"><label>会议链接</label><input v-model="arrangeForm.meetingUrl" placeholder="https://..." /></div>
        <div class="form-field">
          <label for="interviewer-search">面试官 · 已选 {{ arrangeForm.interviewerIds.length }} 人</label>
          <input id="interviewer-search" v-model="interviewerSearch" type="search" placeholder="搜索姓名或邮箱" />
          <div class="interviewer-options" :aria-busy="scheduleLoading">
            <label v-for="person in filteredInterviewers" :key="person.id" class="interviewer-option">
              <input v-model="arrangeForm.interviewerIds" type="checkbox" :value="person.id" :disabled="scheduleLoading" />
              <span>{{ person.displayName }}<small>{{ person.email }}</small></span>
            </label>
            <p v-if="!filteredInterviewers.length" class="muted">暂无匹配的企业成员</p>
          </div>
        </div>
        <div v-if="selectedInterviewers.length" class="form-field">
          <label for="interview-lead">面试负责人</label>
          <select id="interview-lead" v-model="arrangeForm.leadId"><option v-for="person in selectedInterviewers" :key="person.id" :value="person.id">{{ person.displayName }}</option></select>
        </div>
        <div v-for="sheet in selectedInterviewers.length ? scheduleSheets : []" :key="sheet.type" class="form-field">
          <label :for="'sheet-owner-' + sheet.type">{{ sheet.label }}评分人</label>
          <select :id="'sheet-owner-' + sheet.type" v-model="arrangeForm.sheetOwners[sheet.type]"><option v-for="person in selectedInterviewers" :key="person.id" :value="person.id">{{ person.displayName }}</option></select>
        </div>
      </fieldset>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="acting" @click="closeArrange">取消</button>
        <button class="btn btn-primary" type="button" :disabled="acting || scheduleLoading || !!scheduleError || (!creatingInterview && !selectedFinalInterview)" @click="submitArrange">{{ acting ? '提交中...' : rescheduling ? '确认重新安排' : initialInvitation ? '创建初试邀约' : '确认安排复试' }}</button>
      </div>
    </div>
  </div>

  <div v-if="showConclude && concludeTarget" class="overlay" role="presentation" @click.self="!acting && (showConclude = false)">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="conclude-dialog-title" :aria-busy="acting">
      <h3 id="conclude-dialog-title">{{ concludeFinal ? '完成复试' : '完成初试' }}</h3>
      <p>{{ concludeTarget.candidate }} · {{ concludeTarget.job }} · {{ concludeTarget.round }}</p>
      <div class="completion-score"><span>本场面试 AI 评分</span><strong>{{ aiScoreLabel(concludeTarget) }}<small v-if="concludeTarget.aiScore !== null && concludeTarget.aiScore !== undefined"> / 100</small></strong></div>
      <div v-if="concludeError" class="error-note" role="alert">{{ concludeError }}</div>
      <div class="form-field">
        <label for="conclude-outcome">面试结论</label>
        <select id="conclude-outcome" v-model="concludeOutcome" :disabled="acting">
          <option v-if="!concludeFinal" value="continue">下一轮</option>
          <option v-else value="offer">通过，进入 Offer</option>
          <option value="reject">未通过</option>
          <option value="cancelled">取消面试</option>
        </select>
      </div>

      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="acting" @click="showConclude = false">取消</button>
        <button class="btn btn-primary" type="button" :disabled="acting" @click="submitConclude">{{ acting ? '提交中...' : '确认完成' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.interviewer-options { max-height: 180px; overflow-y: auto; border: 1px solid #dce5ed; border-radius: 6px; padding: 6px; }
.interviewer-option { display: flex; align-items: center; gap: 10px; padding: 7px; cursor: pointer; }
.interviewer-option input { width: 16px; height: 16px; flex: 0 0 auto; }
.interviewer-option span { min-width: 0; overflow-wrap: anywhere; }
.interviewer-option small { display: block; color: #6b7d8c; margin-top: 3px; }
.interviewer-option:has(input:checked) { background: #edf6ff; }
.schedule-fields { min-width: 0; margin: 0; padding: 0; border: 0; }
</style>

<style scoped>
.completion-score{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;margin-bottom:18px;border-bottom:1px solid #e1edf4;color:#648093;font-size:13px}.completion-score strong{color:#237a82;font-size:22px}.completion-score small{font-size:12px;font-weight:400;color:#7890a0}
.interview-filters {
  display: grid;
  grid-template-columns: minmax(240px, 1.6fr) repeat(5, minmax(165px, 1fr));
  align-items: center;
  gap: 12px 16px;
  margin: 4px 0 16px;
  padding: 16px;
  border: 1px solid #e1edf4;
  border-radius: 8px;
  background: rgba(247, 252, 253, .96);
  box-shadow: 0 9px 24px rgba(68, 111, 139, .08), inset 0 1px 0 #fff;
}
.interview-filters:focus-within { border-color: #b9d9ec; }
.search-field { display: flex; align-items: center; gap: 10px; min-width: 0; }
.filter-field { display: flex; align-items: center; gap: 8px; min-width: 0; }
.filter-field label { color: #6f879a; font-size: 12px; font-weight: 650; white-space: nowrap; }
.filter-field label::before { display: inline-block; width: 5px; height: 5px; margin-right: 6px; border-radius: 50%; background: #78c9b5; content: ''; vertical-align: middle; }
.interview-filters input, .interview-filters select {
  flex: 1;
  min-width: 0;
  min-height: 38px;
  border: 1px solid #d8e7ef;
  border-radius: 8px;
  background: #fff;
  color: #36536a;
  outline: none;
  transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
}
.interview-filters input { width: 100%; padding: 0 12px; }
.interview-filters select { width: 130px; padding: 0 8px; cursor: pointer; }
.interview-filters input:hover, .interview-filters select:hover { border-color: #afd2e4; transform: translateY(-1px); }
.interview-filters input:focus, .interview-filters select:focus { border-color: #66b8d0; box-shadow: 0 0 0 3px rgba(102, 184, 208, .14); }
.interview-filters .btn { flex-shrink: 0; min-height: 38px; white-space: nowrap; }
.filter-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; grid-column: 1 / -1; min-height: 38px; border-top: 1px solid #e1edf4; padding-top: 10px; color: #6f879a; font-size: 12px; }
.filter-summary strong { color: #277f96; }
@media (max-width: 1200px) {
  .interview-filters { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .search-field { grid-column: span 2; }
}
@media (max-width: 600px) {
  .interview-filters { grid-template-columns: minmax(0, 1fr); padding: 12px; }
  .search-field { grid-column: auto; }
  .filter-field label { min-width: 64px; }
}
.load-failure {
  padding: 32px;
  text-align: center;
}
.arrange-dialog {
  max-width: 860px;
  max-height: min(86vh, 760px);
  overflow-y: auto;
}

</style>
