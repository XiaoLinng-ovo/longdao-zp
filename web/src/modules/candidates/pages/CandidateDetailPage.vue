<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getAnalysisAssessment, getAnalysisExtraction, getCandidate, reviewAnalysisResult, type ApiCandidateDetail } from '../api'
import { recommendationLabel } from '../labels'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import PageHeader from '../../../shared/components/PageHeader.vue'

const route = useRoute()
const router = useRouter()

const detail = ref<ApiCandidateDetail | null>(null)
const loading = ref(true)
const error = ref('')
const showEdit = ref(false)
const savingEdit = ref(false)
const editForm = ref({
  score: 0,
  recommendation: '',
  strengths: '',
  risks: '',
  comment: '',
})

const latestResult = computed(() => {
  const results = detail.value?.analysisResults ?? []
  return results.find((item) => getAnalysisAssessment(item) || getAnalysisExtraction(item))
})

const extraction = computed(() => getAnalysisExtraction(latestResult.value))
const assessment = computed(() => getAnalysisAssessment(latestResult.value))

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
  ].filter((item): item is { label: string; value: number } => typeof item.value === 'number')
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
  const scoreValue = Number(editForm.value.score)
  if (!Number.isFinite(scoreValue) || scoreValue < 0 || scoreValue > 100) {
    error.value = '综合评分必须在 0-100 之间'
    return
  }
  savingEdit.value = true
  error.value = ''
  try {
    await reviewAnalysisResult(latestResult.value.id, {
      status: 'accepted',
      comment: editForm.value.comment.trim() || '人工编辑分析结果和得分',
      edits: {
        score: scoreValue,
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

onMounted(load)
</script>

<template>
  <PageHeader title="候选人详情" :description="candidateProfile.fullName">
    <div class="inline-actions">
      <button class="btn btn-ghost" type="button" @click="router.back">返回列表</button>
      <button class="btn btn-ghost" type="button" @click="load">刷新</button>
    </div>
  </PageHeader>

  <div v-if="loading" class="loading-note">正在读取候选人...</div>
  <div v-else-if="error" class="error-note">{{ error }}</div>

  <template v-else-if="detail">
    <section class="form-panel">
      <div class="section-title">个人信息</div>
      <div class="profile-grid">
        <div class="profile-item"><span>姓名</span><strong>{{ candidateProfile.fullName }}</strong></div>
        <div class="profile-item"><span>邮箱</span><strong>{{ candidateProfile.email }}</strong></div>
        <div class="profile-item"><span>电话</span><strong>{{ candidateProfile.phone }}</strong></div>
        <div class="profile-item"><span>当前方向</span><strong>{{ candidateProfile.headline }}</strong></div>
        <div v-if="candidateProfile.experienceYears != null" class="profile-item">
          <span>相关经验</span><strong>{{ candidateProfile.experienceYears }} 年</strong>
        </div>
      </div>
    </section>

    <section class="form-panel">
      <div class="section-title">简历信息</div>
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
              {{ item.evidence || item.description || item.title || item.employer }}
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
        <button v-if="latestResult" class="btn btn-ghost btn-sm" type="button" @click="openEdit">编辑分析结果和得分</button>
      </div>
      <div v-if="!assessment" class="list-muted">暂无岗位匹配评分</div>
      <template v-else>
        <div class="score-overview">
          <div class="score-card">
            <strong>{{ score != null ? score : '—' }}</strong>
            <span>综合评分</span>
          </div>
          <div class="score-copy">
            <h4>{{ recommendation }}</h4>
            <p>评分基于岗位硬性要求、工作经验、技能、教育背景和岗位潜力综合计算。</p>
            <div class="dimension-list">
              <div v-for="item in dimensions" :key="item.label" class="dimension-item">
                <span>{{ item.label }}</span>
                <strong>{{ item.value }}</strong>
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
              综合评分：
              {{ record.before?.score ?? '—' }}
              →
              {{ record.after?.score ?? '—' }}
            </p>
          </div>
        </div>
      </template>
    </section>
  </template>

  <div v-if="showEdit" class="overlay" role="presentation" @click.self="showEdit = false">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>编辑分析结果和得分</h3>
      <div class="form-grid">
        <div class="form-field">
          <label for="candidate-analysis-score">综合评分（0-100）</label>
          <input id="candidate-analysis-score" v-model.number="editForm.score" type="number" min="0" max="100" />
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

.btn-sm {
  padding: 5px 9px;
  font-size: 11.5px;
}

.form-wide {
  grid-column: 1 / -1;
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
