<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
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
  createLiveInterviewSession,
  uploadLiveInterviewChunk,
  endLiveInterviewSession,
  type LiveInterviewSegment,
  analyzeLiveSegment,
  correctLiveSegmentRole,
  type LiveAnswerAnalysis,
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
const liveSessionId = ref('')
const liveStatus = ref<'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'failed'>('idle')
const liveSegments = ref<LiveInterviewSegment[]>([])
const liveError = ref('')
const currentQuestion = ref('请先做一下自我介绍，并重点说明与你应聘岗位相关的经历。')
const analyzingSegmentId = ref('')
const liveAnalyses = ref<Record<string, LiveAnswerAnalysis>>({})
let liveRecorder: MediaRecorder | undefined

function toBase64(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onloadend = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(reader.error || new Error('读取录音片段失败')); reader.readAsDataURL(blob) }) }
async function startLiveInterview() {
  if (!detail.value || liveStatus.value === 'recording' || liveStatus.value === 'starting') return
  liveError.value = ''; liveStatus.value = 'starting'
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('当前浏览器不支持麦克风录音')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const session = await createLiveInterviewSession(detail.value.id); liveSessionId.value = session.id
    liveRecorder = new MediaRecorder(stream)
    liveRecorder.ondataavailable = async (event) => { if (!event.data.size || !liveSessionId.value) return; try { const items = await uploadLiveInterviewChunk(liveSessionId.value, await toBase64(event.data), event.data.type || 'audio/webm'); liveSegments.value.push(...items) } catch (cause) { liveError.value = cause instanceof Error ? cause.message : '语音片段上传失败'; liveStatus.value = 'failed' } }
    liveRecorder.onstop = () => stream.getTracks().forEach((track) => track.stop())
    liveRecorder.start(4000); liveStatus.value = 'recording'
  } catch (cause) { liveError.value = cause instanceof Error ? cause.message : '无法启动现场面试录音'; liveStatus.value = 'failed' }
}
function pauseLiveInterview() { if (liveRecorder?.state === 'recording') { liveRecorder.pause(); liveStatus.value = 'paused' } else if (liveRecorder?.state === 'paused') { liveRecorder.resume(); liveStatus.value = 'recording' } }
async function stopLiveInterview() { if (!liveRecorder || !liveSessionId.value) return; liveStatus.value = 'stopping'; liveRecorder.stop(); await endLiveInterviewSession(liveSessionId.value); liveStatus.value = 'idle' }
async function setSegmentRole(segment: LiveInterviewSegment, role: 'interviewer' | 'candidate') { try { const updated=await correctLiveSegmentRole(segment.id,role); Object.assign(segment,updated) } catch(cause) { liveError.value=cause instanceof Error?cause.message:'修正说话人失败' } }
async function analyzeSegment(segment: LiveInterviewSegment) { if(!currentQuestion.value.trim()||analyzingSegmentId.value)return; analyzingSegmentId.value=segment.id; liveError.value=''; try { const result=await analyzeLiveSegment(segment.id,currentQuestion.value.trim()); liveAnalyses.value={...liveAnalyses.value,[segment.id]:result}; currentQuestion.value=result.nextQuestion } catch(cause) { liveError.value=cause instanceof Error?cause.message:'回答分析失败' } finally { analyzingSegmentId.value='' } }

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
onUnmounted(() => { if (liveRecorder && liveRecorder.state !== 'inactive') liveRecorder.stop() })
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

      <div class="card live-interview-card">
        <div class="section-title">AI 现场面试</div>
        <p class="list-muted">自动采集现场语音并按说话人分段。AI 仅提供分析建议，不会自动淘汰或录用。</p>
        <div class="inline-actions">
          <button v-if="liveStatus === 'idle' || liveStatus === 'failed'" class="btn btn-primary" type="button" @click="startLiveInterview">开始 AI 面试</button>
          <button v-if="liveStatus === 'recording' || liveStatus === 'paused'" class="btn btn-ghost" type="button" @click="pauseLiveInterview">{{ liveStatus === 'paused' ? '继续录音' : '暂停录音' }}</button>
          <button v-if="liveStatus === 'recording' || liveStatus === 'paused'" class="btn btn-ghost" type="button" @click="stopLiveInterview">结束 AI 面试</button>
          <span class="live-state" :data-state="liveStatus">{{ liveStatus === 'recording' ? '正在录音' : liveStatus === 'paused' ? '已暂停' : liveStatus === 'starting' ? '正在启动' : liveStatus === 'stopping' ? '正在保存' : liveStatus === 'failed' ? '启动失败' : '未启动' }}</span>
        </div>
        <div v-if="liveError" class="feedback error" role="alert">{{ liveError }}</div>
        <div class="form-field live-question"><label>当前问题</label><textarea v-model="currentQuestion" rows="2" /></div>
        <div v-if="liveSegments.length" class="live-transcript">
          <article v-for="segment in liveSegments" :key="segment.id" class="live-segment" :data-role="segment.role">
            <strong>{{ segment.role === 'candidate' ? '候选人' : segment.role === 'interviewer' ? '面试官' : '待确认' }}</strong><span>{{ segment.text }}</span><small>{{ Math.round(segment.confidence * 100) }}% 置信</small>
            <div class="segment-actions"><button class="btn btn-ghost" type="button" @click="setSegmentRole(segment,'interviewer')">标为面试官</button><button class="btn btn-ghost" type="button" @click="setSegmentRole(segment,'candidate')">标为候选人</button><button v-if="segment.role === 'candidate' && segment.confidence >= .6" class="btn btn-primary" type="button" :disabled="!!analyzingSegmentId" @click="analyzeSegment(segment)">{{ analyzingSegmentId === segment.id ? '分析中...' : '分析回答' }}</button></div>
            <div v-if="liveAnalyses[segment.id]" class="segment-analysis"><strong>AI 分析</strong><p>{{ liveAnalyses[segment.id]!.summary }}</p><div class="analysis-scores"><span v-for="score in liveAnalyses[segment.id]!.scores" :key="score.dimension">{{ score.dimension }} {{ score.score }}/10</span></div><p><b>证据：</b>{{ liveAnalyses[segment.id]!.evidence.join('；') || '无' }}</p><p><b>建议下一题：</b>{{ liveAnalyses[segment.id]!.nextQuestion }}</p></div>
          </article>
        </div>
        <div v-else class="list-muted">启动后这里会显示带角色标签的实时转写。</div>
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

<style scoped>
.live-interview-card { grid-column: 1 / -1; }
.live-state { font-size: 13px; color: var(--text-muted); }
.live-state[data-state="recording"] { color: #b91c1c; font-weight: 700; }
.live-transcript { display: grid; gap: 8px; margin-top: 14px; max-height: 360px; overflow: auto; }
.live-segment { display: grid; grid-template-columns: 76px minmax(0, 1fr) 72px; gap: 10px; align-items: start; padding: 10px 12px; border-left: 3px solid #94a3b8; background: #f8fafc; }
.live-segment[data-role="interviewer"] { border-color: #2563eb; }
.live-segment[data-role="candidate"] { border-color: #0f766e; }
.live-segment small { color: var(--text-muted); text-align: right; }
.live-question { margin-top: 14px; }
.segment-actions, .segment-analysis { grid-column: 2 / -1; display: flex; gap: 8px; flex-wrap: wrap; }
.segment-analysis { display: block; padding: 10px; border: 1px solid #dbeafe; background: #fff; }
.segment-analysis p { margin: 6px 0; }
.analysis-scores { display: flex; gap: 8px; flex-wrap: wrap; color: #0f766e; font-weight: 600; }
@media (max-width: 720px) { .live-segment { grid-template-columns: 68px minmax(0, 1fr); } .live-segment small { grid-column: 2; text-align: left; } }
</style>

