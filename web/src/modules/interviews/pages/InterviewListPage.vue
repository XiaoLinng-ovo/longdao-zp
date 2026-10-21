<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  concludeInterview,
  deleteInterview,
  createInterview,
  INTERVIEW_TYPE_LABEL,
  loadInterviewScheduleData,
  loadInterviews,
  lockFeedback,
  RECOMMENDATION_LABEL,
  submitFeedback,
  type ApiApplication,
  type FeedbackRecommendation,
  type InterviewScheduleData,
  type InterviewType,
  type InterviewView,
  type InterviewerOption,
  type ScheduleCandidate,
  type ScheduleJob,
} from '../api'
import { createApplication } from '../../candidates/api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { normalizeSearchText } from '../../../shared/utils/search'
import PageHeader from '../../../shared/components/PageHeader.vue'
import PageFeedback from '../../../shared/components/workflow/PageFeedback.vue'
import InterviewTable from '../components/InterviewTable.vue'

const rows = ref<InterviewView[]>([])
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
const feedbackStatusLabels: Record<string, string> = { scheduled: '已安排', submitted: '已提交', completed: '已完成' }
const jobOptions = computed(() => [...new Set(rows.value.map((row) => row.job).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')))
const roundOptions = computed(() => [...new Set(rows.value.map((row) => row.round).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })))
const interviewerOptions = computed(() => [...new Set(rows.value.flatMap((row) => row.interviewers).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')))
const filteredRows = computed(() => {
  const query = normalizeSearchText(searchQuery.value.trim())
  const matching = rows.value.filter((row) =>
    (!jobFilter.value || row.job === jobFilter.value)
    && (!statusFilter.value || row.feedbackStatus === statusFilter.value)
    && (!roundFilter.value || row.round === roundFilter.value)
    && (!interviewerFilter.value || row.interviewers.includes(interviewerFilter.value))
    && (!query || [row.candidate, row.job, row.id, row.round, row.scheduledAt, feedbackStatusLabels[row.feedbackStatus], ...row.interviewers]
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
const scheduleLoading = ref(false)
const scheduleError = ref('')
let scheduleVersion = 0

const invitationMode = ref<'online' | 'offline'>('online')
const initialInvitation = computed(() => route.query.stage === 'initial' && !!arrangingApplicationId.value)
const showArrange = ref(false)
const arrangeForm = ref({
  candidateId: '',
  jobId: '',
  title: '',
  type: 'technical' as InterviewType,
  scheduledAt: '',
  location: '',
  meetingUrl: '',
  interviewerId: '',
})

const showFeedback = ref(false)
const feedbackTarget = ref<InterviewView | null>(null)
const feedbackForm = ref({
  interviewerId: '',
  overallScore: 80,
  recommendation: 'yes' as FeedbackRecommendation,
  strengths: '',
  concerns: '',
  notes: '',
})
const showConclude = ref(false)
const concludeTarget = ref<InterviewView | null>(null)
const concludeOutcome = ref<'continue' | 'offer' | 'reject'>('continue')

const interviewTypes = computed(() => Object.entries(INTERVIEW_TYPE_LABEL).map(([value, label]) => ({ value, label })))
const recommendations = computed(() => Object.entries(RECOMMENDATION_LABEL).map(([value, label]) => ({ value, label })))
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
  : application.candidateId === arrangeForm.value.candidateId && application.jobId === arrangeForm.value.jobId))

function clearFlags() { error.value = ''; feedback.value = '' }

async function refresh() {
  loading.value = true
  clearFlags()
  try {
    rows.value = await loadInterviews()
    loadFailed.value = false
  } catch (cause) {
    loadFailed.value = true
    error.value = describeApiFailure(cause, '读取面试失败').message
  } finally {
    loading.value = false
  }
}

async function openArrange(applicationId = '') {
  if (acting.value) return
  const version = ++scheduleVersion
  clearFlags()
  scheduleError.value = ''
  arrangingApplicationId.value = applicationId
  invitationMode.value = 'online'
  candidateSearch.value = ''
  arrangeForm.value = { candidateId: '', jobId: '', title: '', type: 'technical', scheduledAt: '', location: '', meetingUrl: '', interviewerId: '' }
  showArrange.value = true
  scheduleLoading.value = true
  try {
    const options: InterviewScheduleData = await loadInterviewScheduleData()
    if (version !== scheduleVersion) return
    candidates.value = options.candidates
    jobs.value = options.jobs
    applications.value = options.applications
    interviewers.value = options.interviewers
    if (applicationId) {
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
  clearApplicationQuery()
}

function clearApplicationQuery() {
  if (!route.query.applicationId) return
  const { applicationId: _applicationId, stage: _stage, ...query } = route.query
  void router.replace({ query })
}

function syncCandidateFromSearch() {
  const selected = candidates.value.find((candidate) => candidateLabel(candidate) === candidateSearch.value.trim())
  arrangeForm.value.candidateId = selected?.id ?? ''
  if (!selected) arrangeForm.value.jobId = ''
}

async function submitArrange() {
  if (acting.value || scheduleLoading.value || scheduleError.value) return
  const form = arrangeForm.value
  if (!form.candidateId.trim()) { error.value = '请选择候选人'; return }
  if (!form.jobId.trim()) { error.value = '请选择岗位'; return }
  if (initialInvitation.value) {
    if (!form.scheduledAt) { error.value = '请选择初试开始时间'; return }
    if (invitationMode.value === 'online' && !form.meetingUrl.trim()) { error.value = '请填写线上初试会议链接'; return }
    if (invitationMode.value === 'offline' && !form.location.trim()) { error.value = '请填写线下初试地点'; return }
  }
  if (!form.title.trim()) form.title = initialInvitation.value ? '初试' : '面试'
  const interviewer = interviewers.value.find((item) => item.id === form.interviewerId)
  if (!interviewer) { error.value = '请选择系统面试官'; return }

  acting.value = true
  clearFlags()
  try {
    const scheduledStartAt = form.scheduledAt ? new Date(form.scheduledAt).toISOString() : undefined
    if (arrangingApplicationId.value && (!existingApplication.value || existingApplication.value.status !== 'interviewing')) {
      throw new Error('原申请已不可安排面试，请返回简历库刷新后重试。')
    }
    const application = existingApplication.value ?? await createApplication({ candidateId: form.candidateId, jobId: form.jobId })
    if (!applications.value.some((item) => item.id === application.id)) applications.value = [...applications.value, application]
    await createInterview({
      applicationId: application.id,
      type: form.type,
      title: form.title.trim(),
      scheduledStartAt,
      location: form.location.trim() || undefined,
      meetingUrl: form.meetingUrl.trim() || undefined,
      participants: [{
        userId: interviewer.id,
        name: interviewer.displayName,
        role: 'interviewer',
        required: true,
      }],
    })
    showArrange.value = false
    arrangingApplicationId.value = ''
    clearApplicationQuery()
    candidateSearch.value = ''
    arrangeForm.value = { candidateId: '', jobId: '', title: '', type: 'technical', scheduledAt: '', location: '', meetingUrl: '', interviewerId: '' }
    await refresh()
    feedback.value = '面试已创建'
  } catch (cause) {
    error.value = describeApiFailure(cause, '安排面试失败').message
  } finally {
    acting.value = false
  }
}

function openFeedback(row: InterviewView) {
  clearFlags()
  feedbackTarget.value = row
  feedbackForm.value = {
    interviewerId: row.interviewerOptions[0]?.id || '',
    overallScore: 80,
    recommendation: 'yes',
    strengths: '',
    concerns: '',
    notes: '',
  }
  showFeedback.value = true
}

function splitList(text: string): string[] {
  return text.split(/[，,、\n]/).map((item) => item.trim()).filter(Boolean)
}

async function submitFeedbackForm() {
  if (acting.value || !feedbackTarget.value) return
  const target = feedbackTarget.value
  const form = feedbackForm.value
  if (!form.interviewerId.trim()) { error.value = '请选择面试官'; return }
  const score = Number(form.overallScore)
  if (!Number.isFinite(score) || score < 0 || score > 100) { error.value = '综合评分需在 0-100 之间'; return }

  acting.value = true
  clearFlags()
  try {
    await submitFeedback(target.entityId, {
      interviewerId: form.interviewerId.trim(),
      overallScore: score,
      recommendation: form.recommendation,
      strengths: splitList(form.strengths),
      concerns: splitList(form.concerns),
      notes: form.notes.trim() || undefined,
    })
    await lockFeedback(target.entityId, form.interviewerId.trim())
    feedback.value = `已提交并锁定 ${target.candidate} 的反馈`
    showFeedback.value = false
    await refresh()
  } catch (cause) {
    error.value = describeApiFailure(cause, '提交反馈失败').message
  } finally {
    acting.value = false
  }
}

function openConclude(row: InterviewView) {
  clearFlags()
  concludeTarget.value = row
  concludeOutcome.value = 'continue'
  showConclude.value = true
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
  acting.value = true
  clearFlags()
  try {
    await concludeInterview(target.entityId, concludeOutcome.value)
    const outcomeLabel = concludeOutcome.value === 'offer' ? '通过，进入 Offer 阶段' : concludeOutcome.value === 'reject' ? '未通过' : '进入下一轮'
    feedback.value = `${target.candidate} 面试已完成：${outcomeLabel}`
    showConclude.value = false
    await refresh()
  } catch (cause) {
    error.value = describeApiFailure(cause, '完成面试失败').message
  } finally {
    acting.value = false
  }
}

onMounted(async () => {
  await refresh()
  if (typeof route.query.applicationId === 'string') await openArrange(route.query.applicationId)
})
watch(() => route.query.applicationId, (applicationId) => {
  if (typeof applicationId === 'string') void openArrange(applicationId)
})
</script>

<template>
  <PageHeader title="面试中心" description="安排面试、收集并锁定面试官反馈，确认面试结论">
    <div class="inline-actions">
      <button class="btn btn-primary" type="button" @click="openArrange()">安排面试</button>
      <button class="btn btn-ghost" type="button" @click="refresh">刷新</button>
    </div>
  </PageHeader>

  <PageFeedback :feedback="feedback" :error="error" @clear-feedback="feedback = ''" @clear-error="error = ''" />
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
      <label for="interview-status-filter">反馈状态</label>
      <select id="interview-status-filter" v-model="statusFilter">
        <option value="">全部状态</option>
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
      <label for="interview-job-sort">岗位排序</label>
      <select id="interview-job-sort" v-model="jobSort">
        <option value="none">默认排序</option>
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
    <button class="btn btn-primary" type="button" @click="refresh">重新加载</button>
  </div>
  <InterviewTable
    v-else
    :rows="filteredRows"
    :empty-message="hasFilters ? '没有符合条件的面试，请调整搜索关键词或清除筛选' : undefined"
    :confirming-delete-id="confirmingDeleteId"
    :deleting-interview-id="deletingInterviewId"
    @feedback="openFeedback"
    @conclude="openConclude"
    @detail="router.push(`/interviews/${$event.entityId}`)"
    @delete="askDeleteInterview"
    @confirm-delete="removeInterview"
    @cancel-delete="cancelDeleteInterview"
  />

  <div v-if="showArrange" class="overlay" role="presentation" @click.self="closeArrange">
    <div class="dialog arrange-dialog" role="dialog" aria-modal="true">
      <h3>{{ initialInvitation ? '初试邀约' : '安排面试' }}</h3>
      <p v-if="arrangingApplicationId" class="muted">正在使用简历筛选通过的原申请，请补充面试信息，不会重新创建申请或重置评分。</p>
      <div v-if="scheduleLoading" role="status">正在读取申请与面试官…</div>
      <div v-if="scheduleError" class="error-note" role="alert">{{ scheduleError }} <button class="btn btn-ghost" type="button" @click="openArrange(arrangingApplicationId)">重试</button></div>
      <div v-if="error" class="error-note" role="alert">{{ error }}</div>
      <div class="form-grid">
        <div class="form-field candidate-search-field">
          <label>候选人（简历库）</label>
          <input v-model="candidateSearch" :disabled="!!arrangingApplicationId || scheduleLoading" list="schedule-candidate-options" placeholder="输入候选人姓名或编号搜索" @input="syncCandidateFromSearch" />
          <datalist id="schedule-candidate-options">
            <option v-for="candidate in filteredCandidates" :key="candidate.id" :value="candidateLabel(candidate)" />
          </datalist>
          <small v-if="!filteredCandidates.length">没有匹配的简历库候选人</small>
        </div>
        <div class="form-field">
          <label>岗位</label>
          <select v-model="arrangeForm.jobId" aria-label="岗位" :disabled="!arrangeForm.candidateId || !!arrangingApplicationId || scheduleLoading">
            <option value="" disabled>选择岗位</option>
            <option v-for="job in jobs" :key="job.id" :value="job.id">{{ job.title }}（{{ job.code }}）</option>
          </select>
          <small v-if="selectedJob && existingApplication">该候选人已有此岗位申请，将复用现有申请。</small>
          <small v-else-if="selectedJob">该候选人尚未投递此岗位，创建面试时会自动创建职位申请。</small>
        </div>
        <div class="form-field"><label>面试标题</label><input v-model="arrangeForm.title" placeholder="例如：技术一面" /></div>
        <div class="form-field">
          <label>面试类型</label>
          <select v-model="arrangeForm.type"><option v-for="t in interviewTypes" :key="t.value" :value="t.value">{{ t.label }}</option></select>
        </div>
        <div class="form-field"><label>开始时间</label><input v-model="arrangeForm.scheduledAt" type="datetime-local" /></div>
        <div v-if="initialInvitation" class="form-field"><label>初试方式</label><select v-model="invitationMode" aria-label="初试方式"><option value="online">线上面试</option><option value="offline">线下面试</option></select></div>
        <div v-if="!initialInvitation || invitationMode === 'offline'" class="form-field"><label>面试地点</label><input v-model="arrangeForm.location" placeholder="线下地点" /></div>
        <div v-if="!initialInvitation || invitationMode === 'online'" class="form-field"><label>会议链接</label><input v-model="arrangeForm.meetingUrl" placeholder="https://..." /></div>
        <div class="form-field">
          <label>面试官</label>
          <select v-model="arrangeForm.interviewerId" aria-label="面试官">
            <option value="" disabled>选择系统用户</option>
            <option v-for="interviewer in interviewers" :key="interviewer.id" :value="interviewer.id">{{ interviewer.displayName }}{{ interviewer.email ? `（${interviewer.email}）` : '' }}</option>
          </select>
          <small v-if="!interviewers.length">暂无可用系统用户，请先在管理后台创建并启用用户。</small>
        </div>
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="acting" @click="closeArrange">取消</button>
        <button class="btn btn-primary" type="button" :disabled="acting || scheduleLoading || !!scheduleError" @click="submitArrange">{{ acting ? '提交中...' : '创建面试' }}</button>
      </div>
    </div>
  </div>

  <div v-if="showFeedback && feedbackTarget" class="overlay" role="presentation" @click.self="showFeedback = false">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>填写面试反馈</h3>
      <p>{{ feedbackTarget.candidate }} · {{ feedbackTarget.job }} · {{ feedbackTarget.round }}</p>
      <div class="form-grid" style="grid-template-columns:1fr 1fr">
        <div class="form-field">
          <label>面试官</label>
          <select v-model="feedbackForm.interviewerId" aria-label="反馈面试官">
            <option value="" disabled>选择本场面试官</option>
            <option v-for="interviewer in feedbackTarget.interviewerOptions" :key="interviewer.id" :value="interviewer.id">{{ interviewer.name }}</option>
          </select>
          <small v-if="!feedbackTarget.interviewerOptions.length">该面试未绑定系统用户，请重新安排面试。</small>
        </div>
        <div class="form-field"><label>综合评分（0-100）</label><input v-model.number="feedbackForm.overallScore" type="number" min="0" max="100" /></div>
        <div class="form-field" style="grid-column:1 / -1">
          <label>推荐结论</label>
          <select v-model="feedbackForm.recommendation"><option v-for="r in recommendations" :key="r.value" :value="r.value">{{ r.label }}</option></select>
        </div>
        <div class="form-field" style="grid-column:1 / -1"><label>优点（逗号分隔）</label><input v-model="feedbackForm.strengths" /></div>
        <div class="form-field" style="grid-column:1 / -1"><label>顾虑（逗号分隔）</label><input v-model="feedbackForm.concerns" /></div>
        <div class="form-field" style="grid-column:1 / -1"><label>备注</label><textarea v-model="feedbackForm.notes" rows="2"></textarea></div>
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="acting" @click="showFeedback = false">取消</button>
        <button class="btn btn-primary" type="button" :disabled="acting || !feedbackTarget.interviewerOptions.length" @click="submitFeedbackForm">{{ acting ? '提交中...' : '提交并锁定' }}</button>
      </div>
    </div>
  </div>

  <div v-if="showConclude && concludeTarget" class="overlay" role="presentation" @click.self="showConclude = false">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>完成面试</h3>
      <p>{{ concludeTarget.candidate }} · {{ concludeTarget.job }} · {{ concludeTarget.round }}</p>
      <div class="form-field">
        <label>面试结论</label>
        <select v-model="concludeOutcome">
          <option value="continue">进入下一轮</option>
          <option value="offer">通过，进入 Offer</option>
          <option value="reject">未通过</option>
        </select>
      </div>
      <p class="list-muted">请先确保所有面试官反馈均已提交并锁定；提交后结论将写入申请状态。</p>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="acting" @click="showConclude = false">取消</button>
        <button class="btn btn-primary" type="button" :disabled="acting" @click="submitConclude">{{ acting ? '提交中...' : '确认完成' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.interview-filters {
  display: flex;
  flex-wrap: wrap;
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
.search-field { display: flex; align-items: center; gap: 10px; flex: 1 1 100%; min-width: 0; }
.filter-field { display: flex; align-items: center; gap: 8px; flex: 1 1 200px; min-width: 0; }
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
.filter-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-basis: 100%; min-height: 38px; border-top: 1px solid #e1edf4; padding-top: 10px; color: #6f879a; font-size: 12px; }
.filter-summary strong { color: #277f96; }
@media (max-width: 600px) {
  .interview-filters { padding: 12px; }
  .filter-field { flex-basis: 100%; }
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
