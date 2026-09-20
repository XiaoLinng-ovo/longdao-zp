<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiClient } from '../../../shared/api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import WorkflowEventTable from '../../../shared/components/workflow/WorkflowEventTable.vue'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { loadWorkflowEvents, type WorkflowEvent } from '../../../shared/api/workflow-events'
import {
  concludeInterview,
  getInterview,
  lockFeedback,
  submitFeedback,
  INTERVIEW_TYPE_LABEL,
  PARTICIPANT_ROLE_LABEL,
  RECOMMENDATION_LABEL,
  type ApiInterviewDetail,
  type FeedbackRecommendation,
} from '../api'

const route = useRoute()
const router = useRouter()
const detail = ref<ApiInterviewDetail | null>(null)
const candidateName = ref('')
const jobTitle = ref('')
const loading = ref(true)
const error = ref('')
const feedback = ref('')
const acting = ref(false)

const showFeedback = ref(false)
const feedbackForm = ref({
  interviewerId: '',
  overallScore: 80,
  recommendation: 'yes' as FeedbackRecommendation,
  strengths: '',
  concerns: '',
  notes: '',
})

const showConclude = ref(false)
const concludeOutcome = ref<'continue' | 'offer' | 'reject'>('continue')
const auditEvents = ref<WorkflowEvent[]>([])
const loadingAudit = ref(false)
const recommendations = computed(() => Object.entries(RECOMMENDATION_LABEL).map(([value, label]) => ({ value, label })))
const interviewerOptions = computed(() => detail.value?.participants.filter((participant) => participant.role === 'interviewer') ?? [])
const scheduleText = computed(() => {
  if (!detail.value) return ''
  const start = formatDate(detail.value.scheduledStartAt)
  return detail.value.scheduledEndAt ? `${start} - ${formatDate(detail.value.scheduledEndAt)}` : start
})
const participantText = computed(() => detail.value?.participants
  .map((participant) => `${participant.name || '待确认'}（${PARTICIPANT_ROLE_LABEL[participant.role] || '面试官'}${participant.required ? '，必须参加' : ''}）`)
  .join('、') || '未设置')

function interviewerName(userId: string): string {
  return detail.value?.participants.find((participant) => participant.userId === userId)?.name || userId
}

function clearFlags() {
  error.value = ''
  feedback.value = ''
}

async function loadAuditEvents(interviewId: string) {
  loadingAudit.value = true
  auditEvents.value = []
  try {
    auditEvents.value = await loadWorkflowEvents('interview', 100).then((rows) => rows.filter((event) => event.subjectId === interviewId))
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
    await loadAuditEvents(id)
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

function openFeedback() {
  if (!detail.value) return
  clearFlags()
  feedbackForm.value = {
    interviewerId: detail.value.participants.find((p) => p.role === 'interviewer')?.userId || detail.value.participants[0]?.userId || '',
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
  if (!detail.value || acting.value) return
  const form = feedbackForm.value
  if (!form.interviewerId.trim()) { error.value = '请选择面试官'; return }
  const score = Number(form.overallScore)
  if (!Number.isFinite(score) || score < 0 || score > 100) { error.value = '综合评分需在 0-100 之间'; return }

  acting.value = true
  clearFlags()
  const id = detail.value.id
  try {
    await submitFeedback(id, {
      interviewerId: form.interviewerId.trim(),
      overallScore: score,
      recommendation: form.recommendation,
      strengths: splitList(form.strengths),
      concerns: splitList(form.concerns),
      notes: form.notes.trim() || undefined,
    })
    await lockFeedback(id, form.interviewerId.trim())
    feedback.value = '面试反馈已提交并锁定'
    showFeedback.value = false
    await load()
  } catch (cause) {
    error.value = describeApiFailure(cause, '提交反馈失败').message
  } finally {
    acting.value = false
  }
}

function openConclude() {
  clearFlags()
  concludeOutcome.value = 'continue'
  showConclude.value = true
}

async function submitConclude() {
  if (!detail.value || acting.value) return
  acting.value = true
  clearFlags()
  const id = detail.value.id
  try {
    await concludeInterview(id, concludeOutcome.value)
    const outcomeLabel = concludeOutcome.value === 'offer' ? '通过，进入 Offer 阶段' : concludeOutcome.value === 'reject' ? '未通过' : '进入下一轮'
    feedback.value = `面试已完成：${outcomeLabel}`
    showConclude.value = false
    await load()
  } catch (cause) {
    error.value = describeApiFailure(cause, '完成面试失败').message
  } finally {
    acting.value = false
  }
}

onMounted(load)
</script>

<template>
  <PageHeader
    title="面试详情"
    :description="detail ? `${candidateName} · ${jobTitle}` : '查看面试安排、候选人与反馈记录'"
  >
    <div class="inline-actions">
      <button v-if="detail && detail.status !== 'cancelled'" class="btn btn-primary" type="button" @click="router.push(`/interviews/${detail.id}/live`)">
        进入 AI 面试室
      </button>
      <button v-if="detail && detail.feedbackStatus !== 'locked' && detail.status !== 'cancelled'" class="btn btn-ghost" type="button" :disabled="acting" @click="openFeedback">
        填写并锁定反馈
      </button>
      <button v-if="detail && detail.status === 'scheduled'" class="btn btn-ghost" type="button" :disabled="acting" @click="openConclude">
        完成面试
      </button>
      <button class="btn btn-ghost" type="button" @click="router.push('/interviews')">返回面试中心</button>
      <button class="btn btn-ghost" type="button" @click="load">刷新</button>
    </div>
  </PageHeader>

  <div v-if="loading" class="loading-note">正在加载面试详情...</div>
  <div v-else-if="error" class="error-note">{{ error }}</div>

  <template v-else-if="detail">
    <div v-if="feedback" class="success-note">{{ feedback }}</div>

    <section class="interview-summary" aria-label="面试关键信息">
      <div class="summary-head">
        <div class="summary-title">
          <strong>{{ INTERVIEW_TYPE_LABEL[detail.type] || detail.type }}</strong>
          <span>第 {{ detail.round }} 轮</span>
        </div>
        <div class="summary-status">
          <StatusTag :status="detail.status" />
          <StatusTag :status="detail.feedbackStatus" />
        </div>
      </div>
      <dl class="summary-facts">
        <div><dt>时间</dt><dd>{{ scheduleText }}</dd></div>
        <div>
          <dt>地点 / 会议</dt>
          <dd><a v-if="detail.meetingUrl" :href="detail.meetingUrl" target="_blank" rel="noreferrer">{{ detail.meetingUrl }}</a><span v-else>{{ detail.location || '未设置' }}</span></dd>
        </div>
        <div><dt>参与人</dt><dd>{{ participantText }}</dd></div>
      </dl>
    </section>

    <section v-if="detail.feedback.length" class="form-panel">
      <div class="section-title">面试反馈</div>
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
    </section>

    <details class="form-panel audit-details">
      <summary>流程审计 <span class="list-muted">{{ auditEvents.length }} 条</span></summary>
      <WorkflowEventTable :events="auditEvents" :loading="loadingAudit" />
    </details>
  </template>

  <div v-if="showFeedback && detail" class="overlay" role="presentation" @click.self="showFeedback = false">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>填写面试反馈</h3>
      <p>{{ candidateName }} · {{ jobTitle }} · {{ detail.round }} 轮</p>
      <div class="form-grid">
        <div class="form-field">
          <label>面试官</label>
          <select v-model="feedbackForm.interviewerId">
            <option value="" disabled>请选择面试官</option>
            <option v-for="p in interviewerOptions" :key="p.userId" :value="p.userId">{{ p.name || '待确认' }}</option>
          </select>
        </div>
        <div class="form-field">
          <label>综合评分（0-100）</label>
          <input v-model.number="feedbackForm.overallScore" type="number" min="0" max="100" />
        </div>
        <div class="form-field">
          <label>推荐结论</label>
          <select v-model="feedbackForm.recommendation">
            <option v-for="r in recommendations" :key="r.value" :value="r.value">{{ r.label }}</option>
          </select>
        </div>
        <div class="form-field form-wide"><label>优点（逗号分隔）</label><input v-model="feedbackForm.strengths" /></div>
        <div class="form-field form-wide"><label>顾虑（逗号分隔）</label><input v-model="feedbackForm.concerns" /></div>
        <div class="form-field form-wide"><label>备注</label><textarea v-model="feedbackForm.notes" rows="3"></textarea></div>
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="acting" @click="showFeedback = false">取消</button>
        <button class="btn btn-primary" type="button" :disabled="acting" @click="submitFeedbackForm">{{ acting ? '提交中...' : '提交并锁定' }}</button>
      </div>
    </div>
  </div>

  <div v-if="showConclude && detail" class="overlay" role="presentation" @click.self="showConclude = false">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>完成面试</h3>
      <p>{{ candidateName }} · {{ jobTitle }} · {{ detail.round }} 轮</p>
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
</style>
