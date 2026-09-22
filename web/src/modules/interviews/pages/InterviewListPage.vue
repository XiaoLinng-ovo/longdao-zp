<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  concludeInterview,
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
import PageHeader from '../../../shared/components/PageHeader.vue'
import PageFeedback from '../../../shared/components/workflow/PageFeedback.vue'
import InterviewTable from '../components/InterviewTable.vue'

const rows = ref<InterviewView[]>([])
const loading = ref(true)
const error = ref('')
const feedback = ref('')
const acting = ref(false)

const candidates = ref<ScheduleCandidate[]>([])
const jobs = ref<ScheduleJob[]>([])
const applications = ref<ApiApplication[]>([])
const interviewers = ref<InterviewerOption[]>([])
const candidateSearch = ref('')
const router = useRouter()

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
const existingApplication = computed(() => applications.value.find((application) => application.candidateId === arrangeForm.value.candidateId && application.jobId === arrangeForm.value.jobId))

function clearFlags() { error.value = ''; feedback.value = '' }

async function refresh() {
  loading.value = true
  clearFlags()
  try {
    rows.value = await loadInterviews()
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取面试失败').message
  } finally {
    loading.value = false
  }
}

async function openArrange() {
  clearFlags()
  candidateSearch.value = ''
  showArrange.value = true
  if (!candidates.value.length && !jobs.value.length) {
    try {
      const options: InterviewScheduleData = await loadInterviewScheduleData()
      candidates.value = options.candidates
      jobs.value = options.jobs
      applications.value = options.applications
      interviewers.value = options.interviewers
    } catch (cause) {
      error.value = describeApiFailure(cause, '读取申请失败').message
    }
  }
}

function syncCandidateFromSearch() {
  const selected = candidates.value.find((candidate) => candidateLabel(candidate) === candidateSearch.value.trim())
  arrangeForm.value.candidateId = selected?.id ?? ''
  if (!selected) arrangeForm.value.jobId = ''
}

async function submitArrange() {
  if (acting.value) return
  const form = arrangeForm.value
  if (!form.candidateId.trim()) { error.value = '请选择候选人'; return }
  if (!form.jobId.trim()) { error.value = '请选择岗位'; return }
  if (!form.title.trim()) form.title = '面试'
  const interviewer = interviewers.value.find((item) => item.id === form.interviewerId)
  if (!interviewer) { error.value = '请选择系统面试官'; return }

  acting.value = true
  clearFlags()
  const scheduledStartAt = form.scheduledAt ? new Date(form.scheduledAt).toISOString() : undefined
  try {
    const application = existingApplication.value ?? await createApplication({ candidateId: form.candidateId, jobId: form.jobId })
    applications.value = [...applications.value, application]
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
    feedback.value = '面试已创建'
    showArrange.value = false
    candidateSearch.value = ''
    arrangeForm.value = { candidateId: '', jobId: '', title: '', type: 'technical', scheduledAt: '', location: '', meetingUrl: '', interviewerId: '' }
    await refresh()
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

onMounted(refresh)
</script>

<template>
  <PageHeader title="面试中心" description="安排面试、收集并锁定面试官反馈，确认面试结论">
    <div class="inline-actions">
      <button class="btn btn-primary" type="button" @click="openArrange">安排面试</button>
      <button class="btn btn-ghost" type="button" @click="refresh">刷新</button>
    </div>
  </PageHeader>

  <PageFeedback :feedback="feedback" :error="error" @clear-feedback="feedback = ''" @clear-error="error = ''" />
  <div v-if="loading" class="loading-note">正在读取面试...</div>
  <InterviewTable v-else :rows="rows" @feedback="openFeedback" @conclude="openConclude" @detail="router.push(`/interviews/${$event.entityId}`)" />

  <div v-if="showArrange" class="overlay" role="presentation" @click.self="showArrange = false">
    <div class="dialog arrange-dialog" role="dialog" aria-modal="true">
      <h3>安排面试</h3>
      <div class="form-grid">
        <div class="form-field candidate-search-field">
          <label>候选人（简历库）</label>
          <input v-model="candidateSearch" list="schedule-candidate-options" placeholder="输入候选人姓名或编号搜索" @input="syncCandidateFromSearch" />
          <datalist id="schedule-candidate-options">
            <option v-for="candidate in filteredCandidates" :key="candidate.id" :value="candidateLabel(candidate)" />
          </datalist>
          <small v-if="!filteredCandidates.length">没有匹配的简历库候选人</small>
        </div>
        <div class="form-field">
          <label>岗位</label>
          <select v-model="arrangeForm.jobId" aria-label="岗位" :disabled="!arrangeForm.candidateId">
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
        <div class="form-field"><label>面试地点</label><input v-model="arrangeForm.location" placeholder="线下地点" /></div>
        <div class="form-field"><label>会议链接</label><input v-model="arrangeForm.meetingUrl" placeholder="https://..." /></div>
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
        <button class="btn btn-ghost" type="button" :disabled="acting" @click="showArrange = false">取消</button>
        <button class="btn btn-primary" type="button" :disabled="acting" @click="submitArrange">{{ acting ? '提交中...' : '创建面试' }}</button>
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
.arrange-dialog {
  max-width: 860px;
  max-height: min(86vh, 760px);
  overflow-y: auto;
}

</style>
