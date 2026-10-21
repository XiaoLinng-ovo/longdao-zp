<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { analyzeResumeForApplication, getAnalysisAssessment, getAnalysisExtraction, getAnalysisTask, getCandidate, getResumeScoreSummary, reanalyzeResume as requestResumeReanalysis, reviewAnalysisResult, type ApiCandidateDetail } from '../api'
import ResumeReviewPanel from '../components/ResumeReviewPanel.vue'
import ResumeDocumentDialog from '../components/ResumeDocumentDialog.vue'
import { recommendationLabel } from '../labels'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import PageHeader from '../../../shared/components/PageHeader.vue'
import { authSession } from '../../auth/session'
import { isJobAnalysisScopeFailure, resumeAnalysisFailureMessage } from '../utils/analysis-failure'

const route = useRoute()
const router = useRouter()

const selectedApplicationId = ref(typeof route.query.applicationId === 'string' ? route.query.applicationId : '')
watch(() => route.query.applicationId, (id) => { selectedApplicationId.value = typeof id === 'string' ? id : '' })
const detail = ref<ApiCandidateDetail | null>(null)
const loading = ref(true)
const error = ref('')
const showEdit = ref(false)
const showResumeDocument = ref(false)
const savingEdit = ref(false)
const submittingAnalysis = ref(false)
const analysisRequestScopeFailure = ref(false)
watch(selectedApplicationId, () => { error.value = ''; analysisRequestScopeFailure.value = false })
let analysisPollTimer: ReturnType<typeof setTimeout> | undefined
let analysisPollToken = 0
const editForm = ref({
  score: 0,
  recommendation: '',
  strengths: '',
  risks: '',
  comment: '',
})

function timestampValue(value?: string): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

const latestResult = computed(() => {
  const results = detail.value?.analysisResults ?? []
  return [...results]
    .filter((item) => (!selectedApplicationId.value || item.applicationId === selectedApplicationId.value) && (getAnalysisAssessment(item) || getAnalysisExtraction(item)))
    .sort((left, right) => timestampValue(right.createdAt) - timestampValue(left.createdAt))[0]
})

const latestResume = computed(() => {
  const tasks = (detail.value?.analysisTasks || []).filter((task) => task.applicationId === selectedApplicationId.value)
  const resumeIds = new Set(tasks.map((task) => task.resumeId))
  const resumes = (detail.value?.resumes ?? []).filter((resume) => !selectedApplicationId.value || resume.applicationId === selectedApplicationId.value || resumeIds.has(resume.id))
  // A newly created application has no task/resume association yet. Reuse a candidate
  // file, but never borrow another application's analysis result or score.
  const available = resumes.length ? resumes : (detail.value?.resumes ?? []).filter((resume) => resume.scanStatus !== 'infected')
  return [...available].sort((left, right) => timestampValue(right.createdAt) - timestampValue(left.createdAt))[0]
})

const currentResume = computed(() => {
  const resumeId = latestResult.value?.resumeId
  return (detail.value?.resumes ?? []).find((resume) => resume.id === resumeId) ?? latestResume.value
})

const currentAnalysisTask = computed(() => {
  const tasks = detail.value?.analysisTasks ?? []
  const resumeId = currentResume.value?.id
  return [...tasks]
    .filter((task) => (!resumeId || task.resumeId === resumeId) && (!selectedApplicationId.value || task.applicationId === selectedApplicationId.value))
    .sort((left, right) => timestampValue(right.createdAt) - timestampValue(left.createdAt))[0]
})

const reanalyzing = computed(() => submittingAnalysis.value || ['queued', 'processing'].includes(currentAnalysisTask.value?.status ?? ''))

watch(() => [currentResume.value?.id, route.params.id, selectedApplicationId.value], () => { showResumeDocument.value = false })

const analysisStatusText = computed(() => {
  const task = currentAnalysisTask.value
  if (submittingAnalysis.value) return '正在提交解析'
  if (analysisRequestScopeFailure.value) return '岗位评分配置异常（任务未启动）'
  if (!task) return '尚未开始解析'
  if (task.status === 'queued') return '等待解析'
  if (task.status === 'processing') return '正在解析'
  if (task.status === 'completed') return '解析完成'
  if (task.status === 'failed' && isJobAnalysisScopeFailure(task.lastError)) return '岗位评分配置异常（本次评分未执行）'
  if (task.status === 'failed') return `解析失败${task.lastError ? `：${task.lastError}` : ''}`
  return task.status
})

const extraction = computed(() => getAnalysisExtraction(latestResult.value))
const assessment = computed(() => getAnalysisAssessment(latestResult.value))
const reviewSummary = computed(() => getResumeScoreSummary(latestResult.value))
const reviewApplication = computed(() => selectedApplicationId.value
  ? detail.value?.applications.find((item) => item.id === selectedApplicationId.value)
  : detail.value?.applications.find((item) => item.id === latestResult.value?.applicationId) ?? detail.value?.applications[0])
const reviewTaskBusy = computed(() => detail.value?.analysisTasks.some((task) => task.applicationId === reviewApplication.value?.id && ['queued', 'processing'].includes(task.status)) ?? false)
const canReview = computed(() => ['recruiter', 'admin', 'hr_admin'].includes(authSession.user?.role ?? ''))

const candidateProfile = computed(() => {
  const extracted = extraction.value?.candidate
  const placeholderNames = new Set(['待解析候选人', '待解析', '未命名候选人'])
  const currentName = detail.value?.fullName?.trim() || ''
  return {
    fullName: placeholderNames.has(currentName) && extracted?.fullName ? extracted.fullName : currentName || extracted?.fullName || '—',
    email: detail.value?.email || extracted?.email || '—',
    phone: detail.value?.phone || extracted?.phone || '—',
    headline: extraction.value?.profile?.headline || extracted?.headline || '—',
    experienceYears: extraction.value?.profile?.totalExperienceYears,
  }
})

const score = computed(() => assessment.value?.score)
const recommendation = computed(() => recommendationLabel(assessment.value?.recommendation))
const reviewHistory = computed(() =>
  latestResult.value?.result.humanReview?.history
  ?? latestResult.value?.result.analysis?.report?.humanReview?.history
  ?? [],
)

const dimensions = computed(() => {
  const values = assessment.value?.dimensions
  if (!values) return []
  return [
    { label: '硬性要求', value: values.hardRequirement },
    { label: '工作经验', value: values.experience },
    { label: '技能匹配', value: values.skills },
    { label: '教育背景', value: values.education },
    { label: '潜力', value: values.potential },
  ].map((item) => ({
    label: item.label,
    text: typeof item.value === 'number' ? String(item.value) : '—',
    missing: typeof item.value !== 'number',
  }))
})

function requirementReason(item: { label?: string; rationale?: string; evidence?: Array<{ sourceText?: string; normalizedValue?: string }> }): string {
  return item.rationale || item.label || item.evidence?.find((evidence) => evidence.sourceText)?.sourceText || ''
}

const matchReasons = computed(() => {
  const reasons = [
    ...(assessment.value?.strengths ?? []),
    ...(assessment.value?.matchedRequirements ?? []).map(requirementReason),
  ].map((item) => item.trim()).filter(Boolean)
  return [...new Set(reasons)]
})

const riskReasons = computed(() => {
  const reasons = [
    ...(assessment.value?.risks ?? []),
    ...(assessment.value?.conflicts ?? []).map(requirementReason),
    ...(assessment.value?.missingRequirements ?? []).map(requirementReason),
  ].map((item) => item.trim()).filter(Boolean)
  return [...new Set(reasons)]
})

async function load() {
  loading.value = true
  error.value = ''
  analysisRequestScopeFailure.value = false
  try {
    const id = String(route.params.id ?? '')
    if (!id) throw new Error('缺少候选人ID')
    detail.value = await getCandidate(id)
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取候选人详情失败').message
  } finally {
    loading.value = false
  }
}

function clearAnalysisPolling() {
  if (analysisPollTimer !== undefined) {
    clearTimeout(analysisPollTimer)
    analysisPollTimer = undefined
  }
  analysisPollToken += 1
}

function scheduleAnalysisPoll(taskId: string, token: number, attempt: number) {
  analysisPollTimer = setTimeout(() => {
    analysisPollTimer = undefined
    void pollAnalysisTask(taskId, token, attempt)
  }, 3000)
}

async function pollAnalysisTask(taskId: string, token: number, attempt = 0): Promise<void> {
  if (token !== analysisPollToken) return
  try {
    const task = await getAnalysisTask(taskId)
    if (token !== analysisPollToken) return
    if (task.status === 'completed') {
      clearAnalysisPolling()
      await load()
      return
    }
    if (task.status === 'failed') {
      clearAnalysisPolling()
      await load()
      error.value = resumeAnalysisFailureMessage(task.lastError)
      return
    }
    if (detail.value) {
      const index = detail.value.analysisTasks.findIndex((item) => item.id === task.id)
      if (index >= 0) detail.value.analysisTasks[index] = { ...detail.value.analysisTasks[index], ...task }
    }
    if (attempt >= 200) {
      error.value = '后台任务长时间未结束，请检查模型服务和 Worker 状态。'
      return
    }
    scheduleAnalysisPoll(taskId, token, attempt + 1)
  } catch (cause) {
    if (token !== analysisPollToken) return
    error.value = describeApiFailure(cause, '查询简历解析状态失败').message
  }
}

async function reanalyzeCurrentResume() {
  const candidateId = detail.value?.id
  const resume = currentResume.value
  if (!candidateId || !resume || reanalyzing.value) return

  submittingAnalysis.value = true
  error.value = ''
  analysisRequestScopeFailure.value = false
  try {
    const task = selectedApplicationId.value && resume.applicationId !== selectedApplicationId.value
      ? await analyzeResumeForApplication(candidateId, resume.id, selectedApplicationId.value)
      : await requestResumeReanalysis(candidateId, resume.id)
    if (detail.value?.id === candidateId) {
      detail.value.analysisTasks = [...detail.value.analysisTasks.filter((item) => item.id !== task.id), { ...task, createdAt: task.createdAt ?? new Date().toISOString() }]
    }
  } catch (cause) {
    analysisRequestScopeFailure.value = isJobAnalysisScopeFailure(cause)
    error.value = resumeAnalysisFailureMessage(cause, '提交简历重新解析失败')
  } finally {
    submittingAnalysis.value = false
  }
}

function splitLines(value: string): string[] {
  return value.split(/\n+/).map((item) => item.trim()).filter(Boolean)
}

function formatEditTime(value?: string): string {
  if (!value) return '时间未知'
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function openEdit() {
  if (!latestResult.value) return
  editForm.value = {
    score: assessment.value?.score ?? 0,
    recommendation: assessment.value?.recommendation ?? 'needs_review',
    strengths: (assessment.value?.strengths ?? []).join('\n'),
    risks: (assessment.value?.risks ?? []).join('\n'),
    comment: '',
  }
  showEdit.value = true
}

async function submitEdit() {
  if (!latestResult.value || savingEdit.value) return
  savingEdit.value = true
  error.value = ''
  try {
    await reviewAnalysisResult(latestResult.value.id, {
      status: 'accepted',
      comment: editForm.value.comment.trim() || '人工编辑分析说明',
      edits: {
        recommendation: editForm.value.recommendation,
        strengths: splitLines(editForm.value.strengths),
        risks: splitLines(editForm.value.risks),
      },
    })
    showEdit.value = false
    await load()
  } catch (cause) {
    error.value = describeApiFailure(cause, '保存分析结果失败').message
  } finally {
    savingEdit.value = false
  }
}

// Reopening a page resumes observation only; it must never enqueue another analysis.
watch(() => [currentAnalysisTask.value?.id, selectedApplicationId.value] as const, () => {
  clearAnalysisPolling()
  const task = currentAnalysisTask.value
  if (task && ['queued', 'processing'].includes(task.status)) void pollAnalysisTask(task.id, analysisPollToken)
})

onMounted(load)
onBeforeUnmount(clearAnalysisPolling)
</script>

<template>
  <PageHeader title="候选人详情" :description="candidateProfile.fullName">
    <div class="inline-actions">
      <button class="btn btn-ghost" type="button" @click="router.back">返回列表</button>
      <button class="btn btn-ghost" type="button" @click="load">刷新</button>
    </div>
  </PageHeader>

  <div v-if="loading && !detail" class="loading-note">正在读取候选人...</div>
  <div v-else-if="error && !detail" class="error-note">{{ error }}</div>

  <template v-else-if="detail">
    <ResumeDocumentDialog v-if="showResumeDocument && currentResume" :candidate-id="detail.id" :resume-id="currentResume.id" :filename="currentResume.originalFilename" @close="showResumeDocument = false" />
    <div v-if="error" class="error-note">{{ error }}</div>
    <div v-if="detail.applications.length > 1 || selectedApplicationId" class="application-context">
      <label for="detail-application">当前查看的岗位申请</label>
      <select id="detail-application" v-model="selectedApplicationId">
        <option value="">最新分析（原视图）</option>
        <option v-for="application in detail.applications" :key="application.id" :value="application.id">{{ detail.jobs.find((job) => job.id === application.jobId)?.title || application.jobId }} · {{ application.code || application.id }}</option>
      </select>
      <small>切换岗位查看各自的评分与分析记录，不会更改原申请。</small>
    </div>
    <section class="form-panel">
      <div class="section-title">个人信息</div>
      <div class="profile-grid">
        <div class="profile-item"><span>姓名</span><strong>{{ candidateProfile.fullName }}</strong></div>
        <div class="profile-item"><span>邮箱</span><strong>{{ candidateProfile.email }}</strong></div>
        <div class="profile-item"><span>电话</span><strong>{{ candidateProfile.phone }}</strong></div>
        <div class="profile-item"><span>简历来源</span><strong>{{ detail.source || '未标注' }}</strong></div>
        <div class="profile-item"><span>当前方向</span><strong>{{ candidateProfile.headline }}</strong></div>
        <div v-if="candidateProfile.experienceYears != null" class="profile-item">
          <span>相关经验</span><strong>{{ candidateProfile.experienceYears }} 年</strong>
        </div>
      </div>
    </section>

    <section class="form-panel">
      <div class="section-title-row">
        <div class="section-title">简历信息</div>
        <div class="resume-actions">
          <span v-if="currentResume" class="resume-file" :title="currentResume.originalFilename">{{ currentResume.originalFilename }}</span>
          <button class="btn btn-primary btn-sm" type="button" :disabled="!currentResume || reanalyzing" @click="reanalyzeCurrentResume">
            {{ reanalyzing ? '解析中...' : latestResult ? '重新解析' : '解析简历' }}
          </button>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="!currentResume" @click="showResumeDocument = true">查看原文档</button>
        </div>
      </div>
      <p v-if="selectedApplicationId && currentResume && currentResume.applicationId !== selectedApplicationId && !latestResult" class="list-muted">将复用候选人已有简历，按当前岗位单独解析评分，不会复制其他岗位的分数。</p>
      <div class="analysis-status" :class="`status-${reanalyzing ? 'processing' : analysisRequestScopeFailure ? 'failed' : currentAnalysisTask?.status || 'idle'}`">
        <span>解析状态</span>
        <strong>{{ analysisStatusText }}</strong>
      </div>
      <p v-if="!reanalyzing && currentAnalysisTask?.status === 'failed' && isJobAnalysisScopeFailure(currentAnalysisTask.lastError)" class="analysis-failure-hint" role="status">{{ resumeAnalysisFailureMessage(currentAnalysisTask.lastError) }}</p>
      <p v-if="!reanalyzing && (currentAnalysisTask?.status === 'failed' || analysisRequestScopeFailure) && latestResult" class="list-muted">以下为上一次成功解析的结果，并非本次重新解析生成；历史评分和人工评价未被覆盖。</p>
      <div v-if="!extraction" class="list-muted">暂无简历解析结果</div>
      <div v-else class="resume-stack">
        <div v-if="extraction.profile?.summary || extraction.profile?.headline" class="resume-block">
          <h4>个人简介</h4>
          <p>{{ extraction.profile.summary || extraction.profile.headline }}</p>
        </div>

        <div v-if="(extraction.experience || []).length" class="resume-block">
          <h4>工作经历</h4>
          <ul>
            <li v-for="(item, index) in extraction.experience" :key="index">
              <div class="experience-head">
                <strong>{{ [item.employer, item.title].filter(Boolean).join(' · ') || '未命名经历' }}</strong>
                <span v-if="item.startDate || item.endDate">{{ [item.startDate, item.endDate].filter(Boolean).join(' - ') }}</span>
              </div>
              <p class="experience-description">{{ item.description || item.evidence }}</p>
            </li>
          </ul>
        </div>

        <div v-if="(extraction.education || []).length" class="resume-block">
          <h4>教育背景</h4>
          <ul>
            <li v-for="(item, index) in extraction.education" :key="index">
              {{ item.evidence || [item.institution, item.degree, item.fieldOfStudy].filter(Boolean).join(' · ') }}
            </li>
          </ul>
        </div>

        <div v-if="(extraction.skills || []).length" class="resume-block">
          <h4>技能</h4>
          <div class="tag-row">
            <span v-for="skill in extraction.skills" :key="skill.value || skill.canonical" class="skill-tag">
              {{ skill.value || skill.canonical }}
            </span>
          </div>
        </div>

        <div v-if="(extraction.languages || []).length" class="resume-block">
          <h4>语言能力</h4>
          <p>{{ (extraction.languages || []).join('、') }}</p>
        </div>

        <div v-if="(extraction.certifications || []).length" class="resume-block">
          <h4>证书</h4>
          <p>{{ (extraction.certifications || []).join('、') }}</p>
        </div>
      </div>
    </section>

    <section class="form-panel">
      <div class="section-title section-title-row">
        <span>AI 与岗位匹配度</span>
        <button v-if="latestResult" class="btn btn-ghost btn-sm" type="button" @click="openEdit">编辑分析说明</button>
      </div>
      <div v-if="!assessment" class="list-muted">暂无岗位匹配评分</div>
      <ResumeReviewPanel v-if="reviewSummary" :key="reviewSummary.resultId" :summary="reviewSummary" :application-status="reviewApplication?.status" :can-edit="canReview" :busy="reviewTaskBusy" @saved="load" />
      <template v-else>
        <div class="score-overview">
          <div class="score-card">
            <strong>{{ score != null ? score : '—' }}</strong>
            <span>{{ score == null ? '暂不可评分' : '综合评分' }}</span>
          </div>
          <div class="score-copy">
            <h4>{{ recommendation }}</h4>
            <p>评分按岗位每条任职要求的满足程度加权计算，硬性要求权重更高；维度分用于快速定位差距，岗位未提供该类要求时显示「—」。没有任职要求时暂不生成综合评分，潜力仅供参考。</p>
            <div class="dimension-list">
              <div v-for="item in dimensions" :key="item.label" class="dimension-item" :title="item.missing ? '岗位未提供该类要求' : undefined">
                <span>{{ item.label }}</span>
                <strong>{{ item.text }}</strong>
              </div>
            </div>
          </div>
        </div>

        <div class="reason-grid">
          <div class="reason-card">
            <h4>匹配原因</h4>
            <ul v-if="matchReasons.length">
              <li v-for="reason in matchReasons" :key="reason">{{ reason }}</li>
            </ul>
            <p v-else class="list-muted">暂无明确匹配说明</p>
          </div>
          <div class="reason-card risk">
            <h4>风险与不足</h4>
            <ul v-if="riskReasons.length">
              <li v-for="reason in riskReasons" :key="reason">{{ reason }}</li>
            </ul>
            <p v-else class="list-muted">暂无明确风险项</p>
          </div>
        </div>

        <div v-if="reviewHistory.length" class="history-block">
          <h4>修改记录</h4>
          <div v-for="(record, index) in reviewHistory" :key="`${record.editedAt}-${index}`" class="history-item">
            <div class="history-head">
              <strong>{{ formatEditTime(record.editedAt) }}</strong>
              <span>{{ record.editedBy || '人工用户' }}</span>
            </div>
            <p v-if="record.comment">{{ record.comment }}</p>
            <p>
              AI 原始评分：{{ record.after?.score ?? record.before?.score ?? '—' }}
            </p>
          </div>
        </div>
      </template>
    </section>
  </template>

  <div v-if="showEdit" class="overlay" role="presentation" @click.self="showEdit = false">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>编辑分析说明</h3>
      <div class="form-grid">
        <div class="form-field">
          <label>AI 原始评分（只读）</label>
          <input :value="score ?? 0" type="number" readonly disabled />
          <small>简历筛选仅使用 AI 评分；编辑说明不会改变 AI 分数或筛选结果。</small>
        </div>
        <div class="form-field">
          <label for="candidate-analysis-recommendation">推荐结论</label>
          <select id="candidate-analysis-recommendation" v-model="editForm.recommendation">
            <option value="strong_match">强匹配</option>
            <option value="match">匹配</option>
            <option value="needs_review">待复核</option>
            <option value="weak_match">弱匹配</option>
          </select>
        </div>
        <div class="form-field form-wide">
          <label for="candidate-analysis-strengths">匹配原因（每行一条）</label>
          <textarea id="candidate-analysis-strengths" v-model="editForm.strengths" rows="4"></textarea>
        </div>
        <div class="form-field form-wide">
          <label for="candidate-analysis-risks">风险与不足（每行一条）</label>
          <textarea id="candidate-analysis-risks" v-model="editForm.risks" rows="4"></textarea>
        </div>
        <div class="form-field form-wide">
          <label for="candidate-analysis-comment">修改说明</label>
          <textarea id="candidate-analysis-comment" v-model="editForm.comment" rows="2" placeholder="说明为什么调整评分或分析结论"></textarea>
        </div>
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="savingEdit" @click="showEdit = false">取消</button>
        <button class="btn btn-primary" type="button" :disabled="savingEdit" @click="submitEdit">
          {{ savingEdit ? '保存中...' : '保存修改' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.application-context { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 14px 16px; margin-bottom: 16px; border: 1px solid #dbeafe; border-radius: 10px; background: #f8fbff; }.application-context label { font-size: 13px; font-weight: 600; }.application-context select { max-width: 100%; border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px; }.application-context small { color: #64748b; }
.profile-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.profile-item {
  min-width: 0;
}

.profile-item span {
  display: block;
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 11px;
}

.profile-item strong {
  display: block;
  color: #1e293b;
  font-size: 14px;
  overflow-wrap: anywhere;
}

.resume-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.resume-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-width: 0;
  flex-wrap: wrap;
}

.resume-actions .btn { flex-shrink: 0; }

.resume-file {
  max-width: min(42vw, 360px);
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.analysis-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 14px;
  padding: 8px 10px;
  border-radius: 7px;
  background: #f8fafc;
  color: var(--muted);
  font-size: 12px;
}

.analysis-status strong {
  color: #334155;
  font-weight: 600;
}

.analysis-status.status-completed strong {
  color: #047857;
}

.analysis-status.status-processing strong,
.analysis-status.status-queued strong {
  color: #1d4ed8;
}

.analysis-status.status-failed strong {
  color: #b91c1c;
}

.analysis-failure-hint {
  color: #b91c1c;
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.btn-sm {
  padding: 5px 9px;
  font-size: 11.5px;
}

.form-wide {
  grid-column: 1 / -1;
}

.experience-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.experience-description {
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.experience-head strong {
  color: #334155;
  font-size: 12.5px;
}

.experience-head span {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 11px;
}

.resume-block li p {
  margin: 4px 0 0;
}

.resume-block {
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.resume-block:first-child {
  border-top: 0;
  padding-top: 0;
}

.resume-block h4,
.reason-card h4,
.score-copy h4 {
  margin: 0 0 8px;
  color: #1e293b;
  font-size: 13px;
}

.resume-block p,
.resume-block ul,
.reason-card ul {
  margin: 0;
  color: #475569;
  font-size: 12.5px;
  line-height: 1.7;
}

.resume-block ul,
.reason-card ul {
  padding-left: 18px;
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.skill-tag {
  padding: 4px 8px;
  border-radius: 6px;
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 12px;
}

.score-overview {
  display: grid;
  grid-template-columns: 170px minmax(0, 1fr);
  gap: 18px;
  align-items: stretch;
}

.score-card {
  display: grid;
  place-items: center;
  min-height: 150px;
  border-radius: 10px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
}

.score-card strong {
  color: #0f766e;
  font-size: 44px;
  line-height: 1;
}

.score-card span {
  color: var(--muted);
  font-size: 12px;
}

.score-copy p {
  margin: 0 0 12px;
  color: var(--muted);
  font-size: 12.5px;
}

.dimension-list {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.dimension-item {
  padding: 9px;
  border-radius: 7px;
  background: #f8fafc;
  text-align: center;
}

.dimension-item span {
  display: block;
  color: var(--muted);
  font-size: 10.5px;
}

.dimension-item strong {
  display: block;
  margin-top: 4px;
  color: #1e293b;
  font-size: 16px;
}

.reason-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 18px;
}

.reason-card {
  padding: 14px;
  border: 1px solid #dbeafe;
  border-radius: 8px;
  background: #f8fbff;
}

.reason-card.risk {
  border-color: #fed7aa;
  background: #fffaf5;
}

.history-block {
  margin-top: 16px;
  border-top: 1px solid var(--border);
  padding-top: 14px;
}

.history-block h4 {
  margin: 0 0 10px;
  color: #1e293b;
  font-size: 13px;
}

.history-item {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: #f8fafc;
}

.history-item + .history-item {
  margin-top: 8px;
}

.history-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: #334155;
  font-size: 12px;
}

.history-item p {
  margin: 6px 0 0;
  color: #475569;
  font-size: 12px;
}

.list-muted {
  color: var(--muted);
  font-size: 12px;
}

@media (max-width: 760px) {
  .profile-grid,
  .score-overview,
  .reason-grid,
  .dimension-list {
    grid-template-columns: 1fr;
  }
}
</style>
