<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiClient } from '../../../shared/api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import WorkflowEventTable from '../../../shared/components/workflow/WorkflowEventTable.vue'
import QuestionSheetDialog from '../components/QuestionSheetDialog.vue'
import InterviewResponsibilities from '../components/InterviewResponsibilities.vue'
import { authSession } from '../../auth/session'
import ApplicationResumeButton from '../../candidates/components/ApplicationResumeButton.vue'
import InterviewSummaryPanel from '../components/InterviewSummaryPanel.vue'
import type { InterviewSummaryView } from '../api/summary'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { navigateToOffer } from '../utils/offer-navigation'
import { stageOfRound, SHEET_TYPE_LABEL } from '../api/question-sheets'
import { loadWorkflowEvents, type WorkflowEvent } from '../../../shared/api/workflow-events'
import {
  completeInterview,
  correctInterviewConclusion,
  getInterview,
  updateInterviewSchedule,
  INTERVIEW_TYPE_LABEL,
  PARTICIPANT_ROLE_LABEL,
  RECOMMENDATION_LABEL,
  type ApiInterviewDetail,
  type FeedbackRecommendation,
  type InterviewScheduleUpdate,
} from '../api'

const route = useRoute()
const router = useRouter()
const detail = ref<ApiInterviewDetail | null>(null)
const canLead = computed(() => ['owner','admin'].includes(authSession.workspaces.find(workspace => workspace.id === authSession.user?.workspaceId)?.role ?? '') || detail.value?.participants.some(person => person.userId === authSession.user?.id && person.lead))
const candidateName = ref('')
const jobTitle = ref('')
const loading = ref(true)
const error = ref('')
const feedback = ref('')
const completedOfferApplicationId = ref('')
async function openCompletedOffer() {
  if (!completedOfferApplicationId.value) return
  if (!await navigateToOffer(router, completedOfferApplicationId.value)) feedback.value = '面试结论已保存，跳转未完成，请点击前往 Offer 管理重试'
}
const enteringLive = ref(false)
const liveEntryError = ref('')
const liveEntryNeedsReload = ref(false)
const liveRoomHref = computed(() => detail.value ? router.resolve('/interviews/' + detail.value.id + '/live').href : '')

async function enterLiveRoom() {
  if (!detail.value || enteringLive.value) return
  enteringLive.value = true
  liveEntryError.value = ''
  liveEntryNeedsReload.value = false
  try {
    const failure = await router.push('/interviews/' + detail.value.id + '/live')
    if (failure) liveEntryError.value = '未能进入面试室，请重试。'
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    liveEntryNeedsReload.value = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (?:CSS )?chunk/i.test(message)
    liveEntryError.value = liveEntryNeedsReload.value
      ? '页面版本已更新或资源加载失败，请重新打开面试室。面试记录不会受影响。'
      : '进入面试室失败，请检查网络后重试。'
  } finally {
    enteringLive.value = false
  }
}
const acting = ref(false)
const showSchedule = ref(false)
const savingSchedule = ref(false)
const scheduleError = ref('')
const scheduleForm = ref({ start: '', end: '', location: '', meetingUrl: '' })
const originalSchedule = ref({ start: '', end: '', location: '', meetingUrl: '' })
const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
const needsFinalSchedule = computed(() => !!detail.value && (detail.value.stage === 'final' || detail.value.round >= 2)
  && (!detail.value.scheduledStartAt || !detail.value.participants.some(person => person.userId && (person.role ?? 'interviewer') === 'interviewer')))

function arrangeFinal() {
  if (!detail.value) return
  void router.push({ path: '/interviews', query: { applicationId: detail.value.applicationId, interviewId: detail.value.id, stage: 'final' } })
}

function localDateTime(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function openSchedule() {
  if (!detail.value || savingSchedule.value) return
  scheduleForm.value = {
    start: localDateTime(detail.value.scheduledStartAt), end: localDateTime(detail.value.scheduledEndAt),
    location: detail.value.location || '', meetingUrl: detail.value.meetingUrl || '',
  }
  originalSchedule.value = { ...scheduleForm.value }
  scheduleError.value = ''
  showSchedule.value = true
}

async function saveSchedule() {
  if (!detail.value || savingSchedule.value) return
  scheduleError.value = ''
  const form = scheduleForm.value
  const start = new Date(form.start === originalSchedule.value.start && detail.value.scheduledStartAt ? detail.value.scheduledStartAt : form.start)
  const end = form.end ? new Date(form.end === originalSchedule.value.end && detail.value.scheduledEndAt ? detail.value.scheduledEndAt : form.end) : null
  if (!form.start || !Number.isFinite(start.getTime())) { scheduleError.value = '请选择有效的面试开始时间'; return }
  if (end && (!Number.isFinite(end.getTime()) || end <= start)) { scheduleError.value = '面试结束时间必须晚于开始时间'; return }
  const meetingUrl = form.meetingUrl.trim()
  if (meetingUrl) {
    try {
      if (!['http:', 'https:'].includes(new URL(meetingUrl).protocol)) throw new Error('invalid URL')
    } catch { scheduleError.value = '请输入以 http:// 或 https:// 开头的有效会议链接'; return }
  }
  const patch: InterviewScheduleUpdate = {}
  if (form.start !== originalSchedule.value.start) patch.scheduledStartAt = start.toISOString()
  if (form.end !== originalSchedule.value.end) patch.scheduledEndAt = end?.toISOString() ?? null
  if (form.location.trim() !== originalSchedule.value.location) patch.location = form.location.trim() || null
  if (meetingUrl !== originalSchedule.value.meetingUrl) patch.meetingUrl = meetingUrl || null
  if (!Object.keys(patch).length) { showSchedule.value = false; return }
  savingSchedule.value = true
  try {
    const updated = await updateInterviewSchedule(detail.value.id, patch)
    detail.value = { ...detail.value, scheduledStartAt: updated.scheduledStartAt, scheduledEndAt: updated.scheduledEndAt,
      location: updated.location, meetingUrl: updated.meetingUrl, updatedAt: updated.updatedAt }
    showSchedule.value = false
    feedback.value = '面试安排已更新'
    await loadAuditEvents(detail.value.application.candidateId)
  } catch (cause) {
    scheduleError.value = describeApiFailure(cause, '保存面试安排失败').message
  } finally {
    savingSchedule.value = false
  }
}

const showComplete = ref(false)
const completeError = ref('')
const showSheets = ref(false)
const summarySection = ref<HTMLElement | null>(null)
const summaryView = ref<InterviewSummaryView | null>(null)
async function locateSummary() {
  await nextTick()
  if (route.query.openSummary === '1') summarySection.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
function summaryUpdated(value: InterviewSummaryView | null) { summaryView.value = value }
const completeOutcome = ref<'continue' | 'offer' | 'reject' | 'cancelled'>('continue')
const showCorrectConclusion = ref(false)
const correctingConclusion = ref(false)
const correctionError = ref('')
const correctionOutcome = ref<'continue' | 'offer' | 'reject' | 'cancelled'>('continue')
const correctionReason = ref('')
const auditEvents = ref<WorkflowEvent[]>([])
const loadingAudit = ref(false)
const completeFinal = computed(() => detail.value?.stage === 'final' || (detail.value?.round ?? 0) >= 2)
const completeAiScore = computed(() => {
  const current = summaryView.value
  if (current) {
    if (current.status === 'failed') return '分析失败'
    if (current.status === 'pending' || current.status === 'generating' || ['transcribing', 'role_review'].includes(current.phase ?? '')) return '分析中'
    if (current.stale) return '待重新评分'
    if (current.report?.reviewRequired) return '证据不足'
    const score = current.status === 'ready' && current.report?.version === 'whole-dialogue-v2' ? current.report.overallScore : null
    return score !== null && score !== undefined && Number.isFinite(score) ? score.toFixed(1) : '暂无评分'
  }
  const score = detail.value?.aiScore
  if (score !== null && score !== undefined && Number.isFinite(score)) return score.toFixed(1)
  return ['pending', 'generating'].includes(detail.value?.aiScoreStatus ?? '') ? '分析中' : '暂无评分'
})
const scheduleText = computed(() => {
  if (!detail.value) return ''
  const start = formatDate(detail.value.scheduledStartAt)
  return detail.value.scheduledEndAt ? `${start} - ${formatDate(detail.value.scheduledEndAt)}` : start
})
const participantText = computed(() => detail.value?.participants
  .map((participant) => `${participant.name || '待确认'}（${PARTICIPANT_ROLE_LABEL[participant.role ?? 'interviewer'] || '面试官'}${participant.required ? '，必须参加' : ''}）`)
  .join('、') || '未设置')

function interviewerName(userId: string): string {
  return detail.value?.participants.find((participant) => participant.userId === userId)?.name || userId
}

function clearFlags() {
  error.value = ''
  feedback.value = ''
}

async function loadAuditEvents(candidateId: string) {
  loadingAudit.value = true
  auditEvents.value = []
  try {
    auditEvents.value = (await loadWorkflowEvents(undefined, 500, candidateId)) || []
  } catch {
    auditEvents.value = []
  } finally {
    loadingAudit.value = false
  }
}

async function load() {
  loading.value = true
  clearFlags()
  try {
    const id = String(route.params.id ?? '')
    if (!id) throw new Error('缺少面试ID')
    detail.value = await getInterview(id)
    const [candidateRes, jobRes] = await Promise.all([
      apiClient.getJson<Array<{ id: string; fullName: string; code?: string }>>('/candidates'),
      apiClient.getJson<Array<{ id: string; title: string; idOnly?: boolean }>>('/jobs'),
    ])
    const app = detail.value.application
    candidateName.value = candidateRes.data.find((item) => item.id === app.candidateId)?.fullName || app.candidateId
    jobTitle.value = jobRes.data.find((item) => item.id === app.jobId)?.title || app.jobId
    await loadAuditEvents(detail.value.application.candidateId)
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取面试详情失败').message
  } finally {
    loading.value = false
  }
}

function formatDate(value?: string) {
  if (!value) return '待安排'
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function recommendationLabel(value?: FeedbackRecommendation) {
  return value ? RECOMMENDATION_LABEL[value] : '未填写'
}

function openComplete() {
  if (!detail.value || acting.value) return
  clearFlags()
  completeError.value = ''
  completeOutcome.value = completeFinal.value ? 'offer' : 'continue'
  showComplete.value = true
}

const conclusionLabel = (outcome?: ApiInterviewDetail['outcome']) => outcome === 'continue' ? '进入下一轮'
  : outcome === 'offer' ? '通过，进入 Offer' : outcome === 'reject' ? '未通过' : outcome === 'cancelled' ? '取消面试' : '未记录'

function openConclusionCorrection() {
  if (!detail.value?.outcome || correctingConclusion.value) return
  correctionOutcome.value = detail.value.outcome
  correctionReason.value = ''
  correctionError.value = ''
  showCorrectConclusion.value = true
}

async function submitConclusionCorrection() {
  if (!detail.value || correctingConclusion.value) return
  const reason = correctionReason.value.trim()
  if (!reason) { correctionError.value = '请填写修改原因'; return }
  if (reason.length > 1000) { correctionError.value = '修改原因不能超过 1000 个字符'; return }
  correctingConclusion.value = true
  correctionError.value = ''
  try {
    await correctInterviewConclusion(detail.value.id, correctionOutcome.value, reason)
    showCorrectConclusion.value = false
    await load()
    feedback.value = '面试结论已更正，原结论及修改原因已记入流程审计'
  } catch (cause) {
    correctionError.value = describeApiFailure(cause, '修改面试结论失败').message
  } finally {
    correctingConclusion.value = false
  }
}

async function submitComplete() {
  if (!detail.value || acting.value) return
  acting.value = true
  clearFlags()
  completeError.value = ''
  const id = detail.value.id
  const applicationId = detail.value.applicationId
  const outcome = completeOutcome.value
  try {
    await completeInterview(id, outcome)
    const outcomeLabel = outcome === 'offer' ? '通过，进入 Offer 阶段'
      : outcome === 'reject' ? '未通过'
        : outcome === 'cancelled' ? '已取消面试' : '进入下一轮'
    showComplete.value = false
    if (outcome === 'offer') {
      detail.value = { ...detail.value!, status: 'completed', outcome }
      completedOfferApplicationId.value = applicationId
      feedback.value = `面试已完成：${outcomeLabel}`
      await openCompletedOffer()
      return
    }
    await load()
    feedback.value = `面试已完成：${outcomeLabel}`
  } catch (cause) {
    const failure = describeApiFailure(cause, '完成面试失败，请稍后重试')
    completeError.value = failure.message
  } finally {
    acting.value = false
  }
}

async function loadRoute() {
  showSheets.value = false
  showSchedule.value = false
  showComplete.value = false
  if (route.query.openQuestionSheet === '1') showSheets.value = true
  summaryView.value = null
  await load()
  await locateSummary()
  if (!error.value && detail.value?.status === 'scheduled' && route.query.arrange === '1') {
    if (needsFinalSchedule.value) arrangeFinal()
    else openSchedule()
  }
  const notice = route.query.reviewNotice
  if (typeof notice === 'string') feedback.value = notice
}
onMounted(loadRoute)
watch(() => route.params.id, () => { void loadRoute() })
watch(() => route.query.openQuestionSheet, value => { if (value === '1') showSheets.value = true })
watch(() => route.query.openSummary, () => { void locateSummary() })
</script>

<template>
  <PageHeader
    title="面试详情"
    :description="detail ? `${candidateName} · ${jobTitle}` : '查看面试安排、候选人与反馈记录'"
  >
    <template #meta>
      <button
        v-if="detail"
        class="sheet-entry"
        type="button"
        title="面试问题表（角色考察点、评分区间、人工打分与阶段综合分）"
        @click="showSheets = true"
      >
        <span aria-hidden="true">▤</span>
        面试问题表
      </button>
    </template>
    <div class="inline-actions">
      <InterviewResponsibilities v-if="detail" :interview="detail" @saved="load" />
      <ApplicationResumeButton v-if="detail" :application-id="detail.applicationId" />
      <button v-if="detail?.status === 'scheduled' && needsFinalSchedule" class="btn btn-primary" type="button" @click="arrangeFinal">安排复试</button>
      <button v-if="detail?.status === 'scheduled' && !needsFinalSchedule" class="btn btn-ghost" type="button" :disabled="acting || savingSchedule" @click="openSchedule">编辑安排</button>
      <button v-if="detail?.status === 'scheduled' && !needsFinalSchedule" class="btn btn-primary" type="button" :disabled="enteringLive" @click="enterLiveRoom">
        {{ enteringLive ? '正在进入...' : '进入 AI 面试室' }}
      </button>
      <button v-else-if="detail?.status === 'completed'" class="btn btn-ghost" type="button" :disabled="enteringLive" @click="enterLiveRoom">
        {{ enteringLive ? '正在打开...' : '查看面试记录' }}
      </button>
      <button v-if="detail && detail.status !== 'cancelled'" class="btn btn-primary" type="button" @click="showSheets = true">
        考察点评分
      </button>
      <button v-if="canLead && detail && detail.status === 'scheduled'" class="btn btn-ghost" type="button" :disabled="acting" @click="openComplete">
        完成面试
      </button>
      <button class="btn btn-ghost" type="button" @click="router.push('/interviews')">返回面试中心</button>
      <button class="btn btn-ghost" type="button" @click="load">刷新</button>
    </div>
  </PageHeader>

  <div v-if="loading" class="loading-note">正在加载面试详情...</div>
  <div v-else-if="error" class="error-note">{{ error }}</div>

  <template v-else-if="detail">
    <div v-if="liveEntryError" class="error-note" role="alert">
      {{ liveEntryError }}
      <a v-if="liveEntryNeedsReload" :href="liveRoomHref">重新打开面试室</a>
    </div>
    <div v-if="feedback" class="success-note">{{ feedback }}</div>
    <button v-if="completedOfferApplicationId" class="btn btn-primary" type="button" @click="openCompletedOffer">前往 Offer 管理</button>

    <section class="interview-summary" aria-label="面试关键信息">
      <div class="summary-head">
        <div class="summary-title">
          <strong>{{ INTERVIEW_TYPE_LABEL[detail.type] || '面试类型待确认' }}</strong>
          <span>第 {{ detail.round }} 轮</span>
        </div>
        <div class="summary-status">
          <StatusTag :status="detail.status" />
        </div>
      </div>
      <dl class="summary-facts">
        <div v-if="detail.outcome"><dt>面试结论</dt><dd>{{ conclusionLabel(detail.outcome) }}</dd></div>
        <div><dt>时间</dt><dd>{{ scheduleText }}</dd></div>
        <div>
          <dt>地点 / 会议</dt>
          <dd class="meeting-details"><span v-if="detail.location">{{ detail.location }}</span><a v-if="detail.meetingUrl" :href="detail.meetingUrl" target="_blank" rel="noreferrer">{{ detail.meetingUrl }}</a><span v-if="!detail.location && !detail.meetingUrl">未设置</span></dd>
        </div>
        <div><dt>参与人</dt><dd>{{ participantText }}</dd></div>
        <div><dt>面试负责人</dt><dd>{{ detail.participants.find(person => person.lead)?.name || '待分配' }}</dd></div>
        <div v-for="person in detail.participants.filter(person => person.sheetTypes?.length)" :key="person.userId"><dt>{{ person.name || person.userId }}</dt><dd>{{ person.sheetTypes?.map(type => SHEET_TYPE_LABEL[type]).join('、') }}</dd></div>
      </dl>
      <div v-if="canLead && detail.outcome" class="conclusion-actions">
        <button class="btn btn-primary conclusion-correction-button" type="button" :disabled="correctingConclusion" @click="openConclusionCorrection">修改面试结论</button>
      </div>
    </section>

    <div id="interview-summary-report" ref="summarySection" class="summary-anchor">
      <InterviewSummaryPanel
        :key="detail.id"
        :interview-id="detail.id"
        :application-id="detail.applicationId"
        :stage="detail.stage ?? stageOfRound(detail.round)"
        :candidate-name="candidateName"
        :job-title="jobTitle"
        :interview-date="detail.scheduledStartAt"
        @updated="summaryUpdated"
      >
        <template #empty-action>
          <button v-if="detail.status === 'scheduled' && !needsFinalSchedule" class="btn btn-primary" type="button" :disabled="enteringLive" @click="enterLiveRoom">{{ enteringLive ? '正在进入...' : '进入 AI 面试室' }}</button>
        </template>
      </InterviewSummaryPanel>
    </div>

    <details v-if="detail.feedback.length" class="form-panel feedback-details">
      <summary class="section-title">面试官反馈</summary>
      <div class="feedback-list">
        <article v-for="item in detail.feedback" :key="item.id" class="feedback-item">
          <div class="feedback-head">
            <strong>{{ interviewerName(item.interviewerId) }}</strong>
            <StatusTag :status="item.status" />
          </div>
          <div class="feedback-meta">
            <span>总分：{{ item.overallScore ?? '未评分' }}</span>
            <span>结论：{{ recommendationLabel(item.recommendation) }}</span>
            <span>提交：{{ formatDate(item.submittedAt) }}</span>
            <span>锁定：{{ formatDate(item.lockedAt) }}</span>
          </div>
          <div class="feedback-detail">
            <p><strong>优点：</strong>{{ item.strengths.join('、') || '无' }}</p>
            <p><strong>顾虑：</strong>{{ item.concerns.join('、') || '无' }}</p>
            <p><strong>备注：</strong>{{ item.notes || '无' }}</p>
          </div>
        </article>
      </div>
    </details>

    <details class="form-panel audit-details">
      <summary>流程审计 <span class="list-muted">{{ auditEvents.length }} 条</span></summary>
      <WorkflowEventTable :events="auditEvents" :loading="loadingAudit" />
    </details>
  </template>

  <div v-if="showSchedule && detail" class="overlay" role="presentation" @click.self="!savingSchedule && (showSchedule = false)">
    <form class="dialog schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title" @submit.prevent="saveSchedule" @keydown.esc="!savingSchedule && (showSchedule = false)">
      <h3 id="schedule-dialog-title">编辑面试安排</h3>
      <p>{{ candidateName }} · {{ jobTitle }} · 第 {{ detail.round }} 轮</p>
      <div v-if="scheduleError" class="error-note" role="alert">{{ scheduleError }}</div>
      <fieldset :disabled="savingSchedule" class="schedule-fields form-grid">
        <div class="form-field">
          <label for="schedule-start">开始时间（{{ localTimezone }}）</label>
          <input id="schedule-start" v-model="scheduleForm.start" type="datetime-local" required />
        </div>
        <div class="form-field">
          <label for="schedule-end">结束时间（选填）</label>
          <input id="schedule-end" v-model="scheduleForm.end" type="datetime-local" />
        </div>
        <div class="form-field form-wide">
          <label for="schedule-location">面试地点</label>
          <input id="schedule-location" v-model="scheduleForm.location" maxlength="1000" />
        </div>
        <div class="form-field form-wide">
          <label for="schedule-url">会议链接</label>
          <input id="schedule-url" v-model="scheduleForm.meetingUrl" type="url" maxlength="2048" />
        </div>
      </fieldset>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="savingSchedule" @click="showSchedule = false">取消</button>
        <button class="btn btn-primary" type="submit" :disabled="savingSchedule">{{ savingSchedule ? '保存中...' : '保存安排' }}</button>
      </div>
    </form>
  </div>

  <div v-if="showComplete && detail" class="overlay" role="presentation" @click.self="!acting && (showComplete = false)">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="complete-dialog-title" :aria-busy="acting">
      <h3 id="complete-dialog-title">完成面试</h3>
      <p>{{ candidateName }} · {{ jobTitle }} · {{ detail.round }} 轮</p>
      <div class="completion-score"><span>本场面试 AI 评分</span><strong>{{ completeAiScore }}<small v-if="detail.aiScore !== null && detail.aiScore !== undefined"> / 100</small></strong></div>
      <div v-if="completeError" class="error-note" role="alert">{{ completeError }}</div>
      <div class="form-field">
        <label for="complete-outcome">面试结论</label>
        <select id="complete-outcome" v-model="completeOutcome" :disabled="acting">
          <option v-if="!completeFinal" value="continue">下一轮</option>
          <option v-else value="offer">通过，进入 Offer</option>
          <option value="reject">未通过</option>
          <option value="cancelled">取消面试</option>
        </select>
      </div>
      <p class="list-muted">完成后将更新候选人申请状态。</p>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="acting" @click="showComplete = false">取消</button>
        <button class="btn btn-primary" type="button" :disabled="acting" @click="submitComplete">{{ acting ? '提交中...' : '确认完成' }}</button>
      </div>
    </div>
  </div>

  <div v-if="showCorrectConclusion && detail" class="overlay" role="presentation" @click.self="!correctingConclusion && (showCorrectConclusion = false)">
    <form class="dialog" role="dialog" aria-modal="true" aria-labelledby="correct-conclusion-title" :aria-busy="correctingConclusion" @submit.prevent="submitConclusionCorrection" @keydown.esc="!correctingConclusion && (showCorrectConclusion = false)">
      <h3 id="correct-conclusion-title">修改面试结论</h3>
      <p>{{ candidateName }} · {{ jobTitle }} · 第 {{ detail.round }} 轮</p>
      <div class="form-field">
        <label>当前结论</label>
        <div class="current-conclusion">{{ conclusionLabel(detail.outcome) }}</div>
      </div>
      <div v-if="correctionError" class="error-note" role="alert">{{ correctionError }}</div>
      <div class="form-field">
        <label for="correct-outcome">更正为</label>
        <select id="correct-outcome" v-model="correctionOutcome" :disabled="correctingConclusion">
          <option v-if="detail.stage !== 'final' && detail.round < 2" value="continue">进入下一轮</option>
          <option v-if="detail.stage === 'final' || detail.round >= 2" value="offer">通过，进入 Offer</option>
          <option value="reject">未通过</option>
          <option value="cancelled">取消面试</option>
        </select>
      </div>
      <div class="form-field">
        <label for="correct-reason">修改原因</label>
        <textarea id="correct-reason" v-model="correctionReason" rows="3" maxlength="1000" required :disabled="correctingConclusion" placeholder="请说明修改原因，便于后续追溯" />
      </div>
      <p class="list-muted">原结论不会删除；如后续复试已开展或已建立 Offer、入职记录，将无法直接更正。</p>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="correctingConclusion" @click="showCorrectConclusion = false">取消</button>
        <button class="btn btn-primary" type="submit" :disabled="correctingConclusion">{{ correctingConclusion ? '保存中...' : '确认修改' }}</button>
      </div>
    </form>
  </div>

  <QuestionSheetDialog
    v-if="detail"
    :open="showSheets"
    :application-id="detail.applicationId"
    :default-stage="detail.stage ?? stageOfRound(detail.round)"
    @close="showSheets = false"
  />
</template>

<style scoped>
.summary-anchor { min-width: 0; scroll-margin-top: 24px; }
.feedback-details > summary { cursor: pointer; }
.completion-score {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 14px 0 18px;
  padding: 14px 0;
  border-bottom: 1px solid #e1edf4;
  color: #648093;
  font-size: 13px;
}

.conclusion-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
}

.current-conclusion {
  padding: 9px 0;
  color: #334155;
  font-weight: 600;
}

.completion-score strong {
  color: #237a82;
  font-size: 22px;
}

.completion-score small {
  color: #7890a0;
  font-size: 12px;
  font-weight: 400;
}

.schedule-fields {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.schedule-dialog {
  max-width: 560px;
  border-radius: 8px;
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
}

.schedule-fields input {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.meeting-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 低调入口：跟在标题说明下方，像「设置」一样的次级链接，不抢主操作。 */
.sheet-entry {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 9px;
  padding: 3px 8px 3px 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: #94a3b8;
  font-size: 11.5px;
  line-height: 1.6;
}

.sheet-entry span {
  font-size: 12px;
}

.sheet-entry:hover {
  border-color: var(--border);
  background: #f8fafc;
  color: #475569;
}

.interview-summary {
  margin-bottom: 16px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  box-shadow: var(--shadow);
}

.summary-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.summary-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.summary-title strong {
  color: #1e293b;
  font-size: 16px;
}

.summary-title span {
  color: var(--muted);
  font-size: 12px;
}

.summary-status {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}

.summary-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin: 14px 0 0;
}

.summary-facts div {
  min-width: 0;
}

.summary-facts dt {
  margin-bottom: 5px;
  color: var(--muted);
  font-size: 11px;
}

.summary-facts dd {
  margin: 0;
  color: #1e293b;
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

.summary-facts a {
  color: var(--primary);
}

.success-note {
  margin: 12px 0 0;
  padding: 9px 11px;
  border: 1px solid #bbf7d0;
  border-radius: 7px;
  background: #f0fdf4;
  color: #166534;
  font-size: 12px;
}

.feedback-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.feedback-item {
  padding: 12px 0;
  border-bottom: 1px solid #edf2f7;
}

.feedback-item:last-child {
  border-bottom: 0;
}

.feedback-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.feedback-head strong {
  color: #1e293b;
  font-size: 13px;
}

.feedback-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-top: 8px;
  color: var(--muted);
  font-size: 12px;
}

.feedback-detail {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 7px;
  background: #f8fafc;
}

.feedback-detail p {
  margin: 0;
  color: #475569;
  font-size: 12.5px;
  line-height: 1.7;
}

.feedback-detail p + p {
  margin-top: 4px;
}

.list-muted {
  color: var(--muted);
  font-size: 12px;
}

.form-wide {
  grid-column: 1 / -1;
}

.audit-details summary {
  cursor: pointer;
  color: #1e293b;
  font-weight: 600;
}

.audit-details summary .list-muted {
  margin-left: 6px;
  font-weight: 400;
}

.audit-details[open] summary {
  margin-bottom: 12px;
}

@media (max-width: 900px) {
  .summary-facts {
    grid-template-columns: 1fr;
  }

  .summary-head {
    flex-direction: column;
  }
}

@media (max-width: 600px) {
  .schedule-fields {
    grid-template-columns: 1fr;
  }
}
</style>
