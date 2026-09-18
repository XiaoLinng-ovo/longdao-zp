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

function clearFlags() { error.value = ''; feedback.value = '' }

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
  if (!form.interviewerId.trim()) { error.value = '请填写面试官 ID'; return }
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
  <div class="page">
    <PageHeader
      title="面试详情"
      subtitle="查看面试安排、候选人与反馈记录"
      icon="④"
      :crumb="detail ? `面试 / ${detail.code || detail.id}` : '面试 / 详情'"
    />

    <div v-if="loading" class="list-muted">正在加载面试详情...</div>
    <div v-else-if="error" class="feedback error">{{ error }}</div>

    <section v-else-if="detail" class="detail-grid">
      <div class="card">
        <div class="section-title">基础信息</div>
        <dl class="info-list">
          <div><dt>编号</dt><dd>{{ detail.code || detail.id }}</dd></div>
          <div><dt>候选人</dt><dd>{{ candidateName }}</dd></div>
          <div><dt>岗位</dt><dd>{{ jobTitle }}</dd></div>
          <div><dt>申请</dt><dd>{{ detail.application?.code || detail.application?.id }}</dd></div>
          <div><dt>轮次</dt><dd>{{ detail.round }} 轮</dd></div>
          <div><dt>类型</dt><dd>{{ INTERVIEW_TYPE_LABEL[detail.type] || detail.type }}</dd></div>
          <div><dt>状态</dt><dd><StatusTag :status="detail.status" /></dd></div>
          <div><dt>反馈状态</dt><dd><StatusTag :status="detail.feedbackStatus" /></dd></div>
          <div><dt>开始时间</dt><dd>{{ formatDate(detail.scheduledStartAt) }}</dd></div>
          <div><dt>结束时间</dt><dd>{{ formatDate(detail.scheduledEndAt) }}</dd></div>
          <div><dt>时区</dt><dd>{{ detail.timezone || '未设置' }}</dd></div>
          <div><dt>面试地点</dt><dd>{{ detail.location || '未设置' }}</dd></div>
          <div><dt>会议链接</dt><dd>{{ detail.meetingUrl || '未设置' }}</dd></div>
        </dl>
      </div>

      <div class="card">
        <div class="section-title">面试操作</div>
        <div class="inline-actions" style="flex-wrap: wrap">
          <button v-if="detail.status !== 'cancelled'" class="btn btn-primary" type="button" @click="router.push(`/interviews/${detail.id}/live`)">进入 AI 面试室</button>
          <button v-if="detail.feedbackStatus !== 'locked' && detail.status !== 'cancelled'" class="btn btn-primary" type="button" :disabled="acting" @click="openFeedback">填写并锁定反馈</button>
          <button v-if="detail.status === 'scheduled'" class="btn btn-ghost" type="button" :disabled="acting" @click="openConclude">完成面试</button>
          <span v-if="detail.status === 'cancelled'" class="list-muted">已取消面试</span>
        </div>
        <div v-if="feedback" class="feedback success" style="margin-top:10px">{{ feedback }}</div>
      </div>

      <div class="card">
        <div class="section-title">面试参与人</div>
        <div v-if="detail.participants.length" class="person-list">
          <div v-for="participant in detail.participants" :key="participant.userId" class="person-item">
            <strong>{{ participant.name || participant.userId }}</strong>
            <span>{{ participant.role }}</span>
            <span>{{ participant.required ? '必须参加' : '可选' }}</span>
          </div>
        </div>
        <div v-else class="list-muted">暂无参与人</div>
      </div>

      <div class="card">
        <div class="section-title">面试反馈</div>
        <div v-if="detail.feedback.length" class="feedback-list">
          <article v-for="item in detail.feedback" :key="item.id" class="feedback-card">
            <div class="feedback-head">
              <strong>{{ item.interviewerId }}</strong>
              <StatusTag :status="item.status" />
            </div>
            <div class="feedback-meta">
              <span>总分：{{ item.overallScore ?? '未评分' }}</span>
              <span>结论：{{ recommendationLabel(item.recommendation) }}</span>
              <span>提交时间：{{ formatDate(item.submittedAt) }}</span>
              <span>锁定时间：{{ formatDate(item.lockedAt) }}</span>
            </div>
            <dl class="info-list compact">
              <div><dt>优点</dt><dd>{{ item.strengths.join('、') || '无' }}</dd></div>
              <div><dt>顾虑</dt><dd>{{ item.concerns.join('、') || '无' }}</dd></div>
              <div><dt>备注</dt><dd>{{ item.notes || '无' }}</dd></div>
            </dl>
          </article>
        </div>
        <div v-else class="list-muted">暂无反馈，可直接在本页填写并锁定反馈。</div>
      </div>

      <div class="card">
        <div class="section-title">流程审计</div>
        <WorkflowEventTable :events="auditEvents" :loading="loadingAudit" />
      </div>

      <div class="inline-actions">
        <button class="btn btn-ghost" type="button" @click="router.push('/interviews')">返回面试中心</button>
      </div>
    </section>

    <div v-if="showFeedback && detail" class="overlay" role="presentation" @click.self="showFeedback = false">
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>填写面试反馈</h3>
        <p>{{ candidateName }} · {{ jobTitle }} · {{ detail.round }} 轮</p>
        <div class="form-grid" style="grid-template-columns:1fr 1fr">
          <div class="form-field"><label>面试官 ID</label><input v-model="feedbackForm.interviewerId" /></div>
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
  </div>
</template>
