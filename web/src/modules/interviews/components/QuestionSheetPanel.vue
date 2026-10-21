<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import StageScoreFormula from './StageScoreFormula.vue'
import {
  STAGE_DECISION_LABEL,
  STAGE_RECOMMENDATION_LABEL,
  SHEET_STATUS_LABEL,
  SHEET_TYPE_LABEL,
  STAGE_LABEL,
  STAGE_SHEET_TYPES,
  TIER_LABEL,
  addSheetQuestion,
  deleteSheetQuestion,
  generateQuestionSheet,
  loadQuestionSheets,
  lockSheet,
  recordStageDecision,
  scoreQuestion,
  submitSheet,
  updateStageWeights,
  unlockSheet,
  type ApiApplicationQuestionSheets,
  type ApiInterviewQuestion,
  type ApiQuestionSheet,
  type InterviewStage,
  type QuestionSheetType,
  type QuestionTier,
  type QuestionTierName,
  type StageDecision,
  type StageWeights,
} from '../api/question-sheets'
import {
  aggregateQuestions,
  cloneWeights,
  scoreForTier,
  sheetScoresOf,
  stageScoreBreakdown,
  STAGE_DEFAULT_WEIGHTS,
} from '../utils/stage-score'

const props = defineProps<{ applicationId: string; defaultStage?: InterviewStage }>()

const view = ref<ApiApplicationQuestionSheets | null>(null)
const stage = ref<InterviewStage>(props.defaultStage ?? 'initial')
const loading = ref(true)
const error = ref('')
const notice = ref('')
const busy = ref('')
const weightsDraft = ref<Record<InterviewStage, StageWeights>>({
  initial: cloneWeights(STAGE_DEFAULT_WEIGHTS.initial),
  final: cloneWeights(STAGE_DEFAULT_WEIGHTS.final),
})
const scoreInputs = ref<Record<string, number | ''>>({})
const commentInputs = ref<Record<string, string>>({})
const pendingDecision = ref<StageDecision | null>(null)
const manualOpen = ref(false)
const manualForm = ref({ question: '', dimension: '', answerText: '' })

const stageTabs = computed(() => (['initial', 'final'] as InterviewStage[]).map((value) => ({
  value,
  label: STAGE_LABEL[value],
  count: view.value?.sheets.filter((sheet) => sheet.stage === value).length ?? 0,
})))

const sheetSlots = computed(() => STAGE_SHEET_TYPES[stage.value].map((sheetType) => ({
  sheetType,
  label: SHEET_TYPE_LABEL[sheetType],
  sheet: view.value?.sheets.find((sheet) => sheet.stage === stage.value && sheet.sheetType === sheetType) ?? null,
})))

const advanced = computed(() => view.value?.reviews.some(item => item.stage === 'initial' && item.decision === 'advanced') ?? false)
let initialViewApplied = false

const review = computed(() => view.value?.reviews.find((item) => item.stage === stage.value) ?? null)

const draft = computed(() => weightsDraft.value[stage.value])

const serverWeights = computed<StageWeights | null>(() => view.value?.stages.find((item) => item.stage === stage.value)?.weights ?? null)

const dirty = computed(() => {
  const saved = serverWeights.value
  if (!saved) return false
  if (Math.abs(saved.recording - draft.value.recording) > 0.0001) return true
  return STAGE_SHEET_TYPES[stage.value].some((sheetType) => Math.abs((saved.sheets[sheetType] ?? 0) - (draft.value.sheets[sheetType] ?? 0)) > 0.0001)
})

/** 实时预览：先把该阶段已提交的表汇总，再按当前（可能未保存的）权重套公式。 */
const previewBreakdown = computed(() => {
  const sheets = view.value?.sheets.filter((sheet) => sheet.stage === stage.value) ?? []
  const recordingScore = view.value?.stages.find((item) => item.stage === stage.value)?.breakdown.items.find((item) => item.key === 'recording')?.score ?? null
  return stageScoreBreakdown(stage.value, sheetScoresOf(sheets), recordingScore, draft.value)
})

const breakdown = computed(() => {
  const server = view.value?.stages.find((item) => item.stage === stage.value)?.breakdown
  if (dirty.value || !server) return previewBreakdown.value
  return server
})

let pollTimer: number | undefined

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
}

function syncPolling(hasPending: boolean): void {
  if (hasPending && pollTimer === undefined) {
    pollTimer = window.setInterval(() => void silentReload(), 3000)
  }
  if (!hasPending) stopPolling()
}

function applyView(next: ApiApplicationQuestionSheets): void {
  view.value = next
  if (!initialViewApplied) {
    if (next.reviews.some(item => item.stage === 'initial' && item.decision === 'advanced')) stage.value = 'final'
    initialViewApplied = true
  }
  for (const item of next.stages) weightsDraft.value[item.stage] = cloneWeights(item.weights)
  syncPolling(next.sheets.some((sheet) => sheet.status === 'generating'))
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    applyView(await loadQuestionSheets(props.applicationId))
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取面试问题表失败').message
  } finally {
    loading.value = false
  }
}

/** 轮询用：失败不打断页面，仅停止轮询，由用户手动刷新。 */
async function silentReload(): Promise<void> {
  try {
    applyView(await loadQuestionSheets(props.applicationId))
  } catch {
    stopPolling()
  }
}

function clearFlags(): void {
  error.value = ''
  notice.value = ''
}

async function generate(sheetType: QuestionSheetType): Promise<void> {
  if (busy.value) return
  busy.value = `generate:${sheetType}`
  clearFlags()
  try {
    applyView(await generateQuestionSheet(props.applicationId, stage.value, sheetType))
    notice.value = `${SHEET_TYPE_LABEL[sheetType]}已提交生成，正在整理本阶段题库与实际问答，完成后自动刷新。`
  } catch (cause) {
    error.value = describeApiFailure(cause, '生成面试表失败').message
  } finally {
    busy.value = ''
  }
}

function patchQuestionInView(question: ApiInterviewQuestion): void {
  const sheets = view.value?.sheets ?? []
  view.value = {
    ...(view.value as ApiApplicationQuestionSheets),
    sheets: sheets.map((sheet) => {
      if (!sheet.questions.some((item) => item.id === question.id)) return sheet
      const questions = sheet.questions.map((item) => (item.id === question.id ? question : item))
      return { ...sheet, questions, aggregate: aggregateQuestions(questions) }
    }),
  }
}

function tierOf(question: ApiInterviewQuestion): QuestionTier[] {
  return question.tiers.length ? question.tiers : [
    { tier: 'excellent', min: 90, max: 100, description: '' },
    { tier: 'pass', min: 70, max: 89, description: '' },
    { tier: 'below', min: 0, max: 69, description: '' },
  ]
}

function editable(sheet: ApiQuestionSheet): boolean {
  return sheet.status === 'scoring'
}

function scoreValue(question: ApiInterviewQuestion): number | '' {
  const local = scoreInputs.value[question.id]
  return local === undefined ? question.finalScore ?? '' : local
}

function onScoreInput(question: ApiInterviewQuestion, raw: string): void {
  scoreInputs.value = { ...scoreInputs.value, [question.id]: raw === '' ? '' : Number(raw) }
}

function commentValue(question: ApiInterviewQuestion): string {
  const local = commentInputs.value[question.id]
  return local === undefined ? question.comment ?? '' : local
}

function onCommentInput(question: ApiInterviewQuestion, raw: string): void {
  commentInputs.value = { ...commentInputs.value, [question.id]: raw }
}

async function saveQuestion(sheet: ApiQuestionSheet, question: ApiInterviewQuestion, patch: { finalTier?: QuestionTierName | null; finalScore?: number | null; comment?: string | null }): Promise<void> {
  if (busy.value) return
  busy.value = `question:${question.id}`
  clearFlags()
  try {
    const updated = await scoreQuestion(props.applicationId, sheet.stage, sheet.sheetType, question.id, patch)
    patchQuestionInView(updated)
    scoreInputs.value = { ...scoreInputs.value, [question.id]: updated.finalScore ?? '' }
    commentInputs.value = { ...commentInputs.value, [question.id]: updated.comment ?? '' }
  } catch (cause) {
    error.value = describeApiFailure(cause, '保存打分失败').message
  } finally {
    busy.value = ''
  }
}

async function pickTier(sheet: ApiQuestionSheet, question: ApiInterviewQuestion, tier: QuestionTierName): Promise<void> {
  const current = typeof scoreValue(question) === 'number' ? (scoreValue(question) as number) : null
  await saveQuestion(sheet, question, { finalTier: tier, finalScore: scoreForTier(tierOf(question), tier, current) })
}

async function commitScore(sheet: ApiQuestionSheet, question: ApiInterviewQuestion): Promise<void> {
  const raw = scoreInputs.value[question.id]
  if (raw === undefined) return
  const next = raw === '' ? null : Number(raw)
  if (next !== null && (!Number.isFinite(next) || next < 0 || next > 100)) {
    error.value = '分数需在 0-100 之间'
    return
  }
  if (next === question.finalScore) return
  const tier = next === null ? null : tierOf(question).find((item) => next >= item.min && next <= item.max)?.tier ?? null
  await saveQuestion(sheet, question, { finalScore: next, finalTier: tier })
}

async function commitComment(sheet: ApiQuestionSheet, question: ApiInterviewQuestion): Promise<void> {
  const raw = commentInputs.value[question.id]
  if (raw === undefined) return
  if (raw === (question.comment ?? '')) return
  await saveQuestion(sheet, question, { comment: raw === '' ? null : raw })
}

async function adoptAiScore(sheet: ApiQuestionSheet, question: ApiInterviewQuestion): Promise<void> {
  if (question.aiScore === null) return
  const tier = tierOf(question).find((item) => question.aiScore !== null && question.aiScore >= item.min && question.aiScore <= item.max)?.tier
    ?? question.aiTier
    ?? null
  await saveQuestion(sheet, question, { finalTier: tier, finalScore: question.aiScore })
}

async function removeQuestion(sheet: ApiQuestionSheet, question: ApiInterviewQuestion): Promise<void> {
  if (busy.value) return
  busy.value = `delete:${question.id}`
  clearFlags()
  try {
    await deleteSheetQuestion(props.applicationId, sheet.stage, sheet.sheetType, question.id)
    await load()
    notice.value = '题目已删除'
  } catch (cause) {
    error.value = describeApiFailure(cause, '删除题目失败').message
  } finally {
    busy.value = ''
  }
}

async function addManualQuestion(sheet: ApiQuestionSheet): Promise<void> {
  if (busy.value) return
  const question = manualForm.value.question.trim()
  if (!question) {
    error.value = '请填写题目内容'
    return
  }
  busy.value = `manual:${sheet.sheetType}`
  clearFlags()
  try {
    await addSheetQuestion(props.applicationId, sheet.stage, sheet.sheetType, {
      question,
      ...(manualForm.value.dimension.trim() ? { dimension: manualForm.value.dimension.trim() } : {}),
      ...(manualForm.value.answerText.trim() ? { answerText: manualForm.value.answerText.trim() } : {}),
    })
    manualForm.value = { question: '', dimension: '', answerText: '' }
    manualOpen.value = false
    await load()
    notice.value = '已补录题目，请继续打分'
  } catch (cause) {
    error.value = describeApiFailure(cause, '补录题目失败').message
  } finally {
    busy.value = ''
  }
}

async function commitSheet(sheet: ApiQuestionSheet): Promise<void> {
  if (busy.value) return
  busy.value = `submit:${sheet.sheetType}`
  clearFlags()
  try {
    await submitSheet(props.applicationId, sheet.stage, sheet.sheetType)
    await load()
    notice.value = `${SHEET_TYPE_LABEL[sheet.sheetType]}已提交，得分已汇总。`
  } catch (cause) {
    error.value = describeApiFailure(cause, '提交面试表失败').message
  } finally {
    busy.value = ''
  }
}

async function freezeSheet(sheet: ApiQuestionSheet): Promise<void> {
  if (busy.value) return
  busy.value = `lock:${sheet.sheetType}`
  clearFlags()
  try {
    await lockSheet(props.applicationId, sheet.stage, sheet.sheetType)
    await load()
    notice.value = `${SHEET_TYPE_LABEL[sheet.sheetType]}已锁定，不能再修改。`
  } catch (cause) {
    error.value = describeApiFailure(cause, '锁定面试表失败').message
  } finally {
    busy.value = ''
  }
}

async function unlockSheetForEdit(sheet: ApiQuestionSheet): Promise<void> {
  if (busy.value) return
  const action = sheet.status === 'locked' ? '解除锁定' : '撤回提交'
  if (!window.confirm(`${action}“${SHEET_TYPE_LABEL[sheet.sheetType]}”后可以继续修改评分，是否继续？`)) return
  busy.value = `unlock:${sheet.sheetType}`
  clearFlags()
  try {
    await unlockSheet(props.applicationId, sheet.stage, sheet.sheetType)
    await load()
    notice.value = `${SHEET_TYPE_LABEL[sheet.sheetType]}已${action}，可以继续修改评分。`
  } catch (cause) {
    error.value = describeApiFailure(cause, `${action}失败`).message
  } finally {
    busy.value = ''
  }
}

async function saveWeights(): Promise<void> {
  if (busy.value) return
  busy.value = 'weights'
  clearFlags()
  try {
    const result = await updateStageWeights(props.applicationId, stage.value, draft.value)
    await load()
    notice.value = `权重已保存，${STAGE_LABEL[stage.value]}综合分按新公式重算：${result.breakdown.formula}`
  } catch (cause) {
    error.value = describeApiFailure(cause, '保存权重失败').message
  } finally {
    busy.value = ''
  }
}

function resetWeights(): void {
  const defaults = STAGE_DEFAULT_WEIGHTS[stage.value]
  weightsDraft.value = { ...weightsDraft.value, [stage.value]: cloneWeights(defaults) }
  notice.value = '已恢复默认权重，保存后生效。'
}

/** 按项合并，避免连续修改两个权重时后一次提交覆盖前一次。 */
function applyWeight(payload: { key: string; value: number }): void {
  const next = cloneWeights(draft.value)
  if (payload.key === 'recording') next.recording = payload.value
  else next.sheets[payload.key] = payload.value
  weightsDraft.value = { ...weightsDraft.value, [stage.value]: next }
}

async function confirmDecision(): Promise<void> {
  if (!pendingDecision.value || busy.value) return
  busy.value = 'decision'
  clearFlags()
  try {
    const decisionStage = stage.value
    const decision = pendingDecision.value
    const result = await recordStageDecision(props.applicationId, decisionStage, decision)
    pendingDecision.value = null
    if (decisionStage === 'initial' && decision === 'advanced') stage.value = 'final'
    await load()
    notice.value = decisionStage === 'initial' && decision === 'advanced'
      ? '已进入复试，第 ' + (result.nextInterview?.round ?? 2) + ' 轮面试已在面试中心展示。'
      : STAGE_LABEL[decisionStage] + '结论已记录。'
  } catch (cause) {
    error.value = describeApiFailure(cause, '记录阶段结论失败').message
  } finally {
    busy.value = ''
  }
}

/** 兼容旧版仅记录“进入复试”但未创建面试的候选人，点击后幂等补齐。 */
async function ensureNextRound(): Promise<void> {
  if (busy.value) return
  busy.value = 'decision'
  clearFlags()
  try {
    await recordStageDecision(props.applicationId, 'initial', 'advanced')
    stage.value = 'final'
    await load()
    notice.value = '第二轮面试已就绪，可进入面试室生成复试题库。'
  } catch (cause) {
    error.value = describeApiFailure(cause, '创建第二轮面试失败').message
  } finally { busy.value = '' }
}

onMounted(load)
onUnmounted(stopPolling)
</script>

<template>
  <section class="form-panel sheet-panel">
    <div class="sheet-panel-head">
      <p class="list-muted sheet-panel-hint">
        所有生成的面试表和题目仅供人工参考；录音 AI 分依据整场实际对话的语义与证据，未问到的参考题不扣分。
      </p>
      <div class="inline-actions">
        <button
          v-for="tab in stageTabs"
          :key="tab.value"
          class="btn"
          :class="stage === tab.value ? 'btn-primary' : 'btn-ghost'"
          type="button"
          @click="stage = tab.value"
        >
          {{ tab.label }}（{{ tab.count }}/{{ STAGE_SHEET_TYPES[tab.value].length }}）
        </button>
        <button class="btn btn-ghost" type="button" @click="load">刷新</button>
      </div>
    </div>

    <div v-if="loading" class="loading-note">正在加载面试问题表...</div>
    <div v-else-if="error" class="error-note">{{ error }}</div>
    <template v-else-if="view">
      <div v-if="notice" class="success-note">{{ notice }}</div>

      <div v-if="advanced" class="success-note next-round" data-testid="next-round">
        <span>已进入复试 · 第 {{ view.nextInterview?.round ?? 2 }} 轮{{ view.nextInterview?.status === 'cancelled' ? '（面试已取消）' : view.nextInterview?.status === 'completed' ? '（面试已完成）' : '' }}</span>
        <template v-if="view.nextInterview">
          <a class="btn btn-primary" :href="'/interviews/' + view.nextInterview.id">查看第 {{ view.nextInterview.round }} 轮面试</a>
          <a v-if="view.nextInterview.status === 'scheduled'" class="btn btn-ghost" :href="'/interviews/' + view.nextInterview.id + '/live'">进入第二轮面试室</a>
        </template>
        <button v-else class="btn btn-primary" type="button" :disabled="!!busy" @click="ensureNextRound">{{ busy === 'decision' ? '正在创建…' : '创建第二轮面试' }}</button>
      </div>

      <StageScoreFormula
        :stage="stage"
        :breakdown="breakdown"
        :draft="draft"
        :review="review"
        :dirty="dirty"
        :saving="busy === 'weights'"
        :deciding="busy === 'decision'"
        @next-stage="stage = 'final'"
        @weight="applyWeight"
        @save="saveWeights"
        @reset="resetWeights"
        @decide="(decision) => (pendingDecision = decision)"
      />

      <article v-for="slot in sheetSlots" :key="slot.sheetType" class="sheet-card">
        <header class="sheet-card-head">
          <div class="sheet-card-title">
            <strong>{{ slot.label }}</strong>
            <span v-if="slot.sheet" class="sheet-status">{{ SHEET_STATUS_LABEL[slot.sheet.status] }}</span>
            <span v-else class="sheet-status sheet-status-empty">未生成</span>
          </div>
          <div class="sheet-card-metrics">
            <span v-if="slot.sheet">已打分 {{ slot.sheet.aggregate.scoredCount }}/{{ slot.sheet.aggregate.totalCount }}</span>
            <span v-if="slot.sheet && slot.sheet.aggregate.score !== null">表内平均 <strong>{{ slot.sheet.aggregate.score }}</strong></span>
            <span v-else-if="slot.sheet && slot.sheet.aggregate.totalCount">暂无打分</span>
          </div>
          <div class="inline-actions">
            <button
              class="btn btn-ghost"
              type="button"
              :disabled="Boolean(busy) || slot.sheet?.status === 'locked' || slot.sheet?.status === 'generating'"
              @click="generate(slot.sheetType)"
            >
              {{ slot.sheet?.status === 'generating' ? '生成中' : slot.sheet && slot.sheet.status !== 'draft' ? '重新生成' : '生成面试表' }}
            </button>
            <button
              v-if="slot.sheet && slot.sheet.status === 'submitted'"
              class="btn btn-ghost"
              type="button"
              :disabled="Boolean(busy)"
              @click="unlockSheetForEdit(slot.sheet)"
            >
              {{ busy === `unlock:${slot.sheet.sheetType}` ? '处理中...' : '撤回提交' }}
            </button>
            <button
              v-if="slot.sheet && slot.sheet.status === 'submitted'"
              class="btn btn-ghost"
              type="button"
              :disabled="Boolean(busy)"
              @click="freezeSheet(slot.sheet)"
            >
              锁定
            </button>
            <button
              v-if="slot.sheet && slot.sheet.status === 'locked'"
              class="btn btn-ghost"
              type="button"
              :disabled="Boolean(busy)"
              @click="unlockSheetForEdit(slot.sheet)"
            >
              {{ busy === `unlock:${slot.sheet.sheetType}` ? '处理中...' : '解除锁定' }}
            </button>
          </div>
        </header>

        <div v-if="slot.sheet && slot.sheet.status === 'scoring'" class="sheet-submit-bar">
          <span>
            <strong>{{ slot.label }}</strong>
            <span class="sheet-submit-progress">已打分 {{ slot.sheet.aggregate.scoredCount }}/{{ slot.sheet.aggregate.totalCount }}</span>
          </span>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="Boolean(busy)"
            @click="commitSheet(slot.sheet)"
          >
            {{ busy === `submit:${slot.sheet.sheetType}` ? '提交中...' : '提交该表' }}
          </button>
        </div>

        <p v-if="slot.sheet?.generationError" class="error-note">生成失败：{{ slot.sheet.generationError }}</p>
        <p v-else-if="slot.sheet?.generationNotice" class="loading-note">{{ slot.sheet.generationNotice }}</p>

        <p v-if="slot.sheet?.status === 'generating'" class="loading-note">
          AI 正在按该阶段的问答生成题目与默认打分，页面每 3 秒自动刷新...
        </p>
        <p v-else-if="!slot.sheet" class="empty-note">
          <span>这张表还没有生成。先完成该阶段面试（或手工补录题目），再点「生成面试表」。</span>
        </p>
        <p v-else-if="!slot.sheet.questions.length" class="empty-note">
          <span>表内暂无题目，可重新生成或手工补录。</span>
        </p>

        <ul v-if="slot.sheet && slot.sheet.questions.length" class="question-list">
          <li v-for="question in slot.sheet.questions" :key="question.id" class="question-row">
            <div class="question-seq">{{ question.seq }}</div>
            <div class="question-main">
              <section class="question-block question-block-prompt">
                <div class="question-block-label">面试问题</div>
                <p class="question-text">{{ question.question }}</p>
              </section>
              <div class="question-meta">
                <span>考察维度：{{ question.dimension || '综合能力' }}</span>
                <span v-if="question.source === 'manual'">手工补录</span>
                <span v-else-if="question.source === 'ai_generated' && !question.questionEventId">面试室题库 · 未记录提问</span>
                <span v-else-if="question.answerText">来自该阶段转写</span>
                <span v-if="question.aiScore !== null">AI 参考 {{ question.aiScore }} 分<template v-if="question.aiTier">（{{ TIER_LABEL[question.aiTier] }}）</template></span>
                <span v-else class="muted-warn">{{ question.answerText?.trim() ? 'AI 评价暂不可用，未给默认分' : '缺少可用回答，AI 未给默认分' }}</span>
              </div>
              <section class="question-block question-block-answer">
                <div class="question-block-label">候选人回答</div>
                <p class="question-answer">{{ question.answerText || '暂无转写回答（线下面试可手工补录）' }}</p>
              </section>
              <section v-if="question.aiRationale" class="question-block question-block-ai">
                <div class="question-block-label">AI 评分依据</div>
                <p class="question-ai">{{ question.aiRationale }}</p>
              </section>

              <div class="tier-row">
                <button
                  v-for="tier in tierOf(question)"
                  :key="tier.tier"
                  class="tier-btn"
                  :class="[`tier-${tier.tier}`, { 'tier-active': question.finalTier === tier.tier }]"
                  type="button"
                  :disabled="!editable(slot.sheet!) || Boolean(busy)"
                  :title="tier.description"
                  @click="pickTier(slot.sheet!, question, tier.tier)"
                >
                  <strong>{{ TIER_LABEL[tier.tier] }}</strong>
                  <span>{{ tier.min }}-{{ tier.max }}</span>
                </button>
                <label class="score-input">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    :value="scoreValue(question)"
                    :disabled="!editable(slot.sheet!) || Boolean(busy)"
                    :aria-label="`第 ${question.seq} 题得分`"
                    @input="onScoreInput(question, ($event.target as HTMLInputElement).value)"
                    @change="commitScore(slot.sheet!, question)"
                  />
                  <span>分</span>
                </label>
                <button
                  v-if="question.aiScore !== null"
                  class="btn btn-ghost btn-inline ai-score-btn"
                  type="button"
                  :disabled="!editable(slot.sheet!) || Boolean(busy)"
                  @click="adoptAiScore(slot.sheet!, question)"
                >
                  采纳 AI 分
                </button>
              </div>

              <div class="comment-row">
                <input
                  :value="commentValue(question)"
                  :disabled="!editable(slot.sheet!) || Boolean(busy)"
                  :placeholder="editable(slot.sheet!) ? '评语（可选，失焦保存）' : '当前面试表不可编辑，请先撤回提交或解除锁定'"
                  @input="onCommentInput(question, ($event.target as HTMLInputElement).value)"
                  @blur="commitComment(slot.sheet!, question)"
                />
              </div>
              <ul v-if="question.aiEvidence.length" class="question-evidence">
                <li v-for="(evidence, index) in question.aiEvidence.slice(0, 3)" :key="index">引用：{{ evidence }}</li>
              </ul>
            </div>
            <button
              v-if="editable(slot.sheet!)"
              class="btn btn-danger question-delete"
              type="button"
              :disabled="Boolean(busy)"
              @click="removeQuestion(slot.sheet!, question)"
            >
              删除
            </button>
          </li>
        </ul>

        <div v-if="slot.sheet && editable(slot.sheet)" class="sheet-card-foot">
          <button class="btn btn-ghost" type="button" @click="manualOpen = !manualOpen">手工补录题目</button>
          <div v-if="manualOpen" class="manual-form">
            <div class="form-field form-wide">
              <label>题目</label>
              <input v-model="manualForm.question" placeholder="例如：请说明你负责的最大项目及你的角色" />
            </div>
            <div class="form-field">
              <label>考察维度</label>
              <input v-model="manualForm.dimension" placeholder="例如：项目经验" />
            </div>
            <div class="form-field form-wide">
              <label>候选人回答要点</label>
              <textarea v-model="manualForm.answerText" rows="2" placeholder="线下面试可在此记录回答要点" />
            </div>
            <div class="dialog-buttons">
              <button class="btn btn-ghost" type="button" @click="manualOpen = false">取消</button>
              <button class="btn btn-primary" type="button" :disabled="Boolean(busy)" @click="addManualQuestion(slot.sheet!)">添加题目</button>
            </div>
          </div>
        </div>
      </article>
    </template>
  </section>

  <div v-if="pendingDecision" class="overlay" role="presentation" data-sheet-confirm @click.self="pendingDecision = null">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>确认{{ STAGE_LABEL[stage] }}结论</h3>
      <p>
        当前综合分：{{ breakdown.score ?? '暂无' }} 分（{{ breakdown.formula }}）；结论由人确认，AI 不自动改申请状态。
      </p>
      <p v-if="stage === 'initial' && pendingDecision === 'advanced'" class="list-muted">确认后将在面试中心创建第二轮复试，保留初试记录，并切换到复试评价。</p>
      <p v-if="review?.aiRecommendation" class="list-muted">
        AI 建议：{{ STAGE_RECOMMENDATION_LABEL[review.aiRecommendation] }}{{ review.aiRationale ? ` · ${review.aiRationale}` : '' }}
      </p>
      <p class="list-muted">将记录为「{{ STAGE_DECISION_LABEL[pendingDecision] }}」，并保留操作人与时间。</p>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" @click="pendingDecision = null">取消</button>
        <button class="btn btn-primary" type="button" :disabled="busy === 'decision'" @click="confirmDecision">
          {{ busy === 'decision' ? '提交中...' : '确认结论' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.next-round{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sheet-panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  /* 弹窗内滚动时，阶段切换与刷新保持可见。 */
  position: sticky;
  top: -16px;
  z-index: 2;
  padding: 14px 0 12px;
  background: #fff;
  border-bottom: 1px solid var(--border);
}

.sheet-panel-head p {
  margin: 0;
}

.sheet-panel-hint {
  flex: 1;
  min-width: 220px;
}

.sheet-card {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: #fff;
  padding: 14px 16px;
}

.sheet-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

/*
 * 题目较多时，提交按钮跟随当前面试表固定在弹窗顶部下方，
 * 评完最后一道题无需再滚回表头。
 */
.sheet-submit-bar {
  position: sticky;
  top: 66px;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 10px -4px 0;
  padding: 8px 10px;
  border: 1px solid #bfdbfe;
  border-radius: 8px;
  background: rgba(239, 246, 255, 0.96);
  box-shadow: 0 4px 12px rgba(30, 64, 175, 0.12);
  backdrop-filter: blur(4px);
}

.sheet-submit-bar > span {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  color: #1e3a8a;
  font-size: 12px;
}

.sheet-submit-bar strong {
  white-space: nowrap;
}

.sheet-submit-progress {
  color: #475569;
  white-space: nowrap;
}

.sheet-submit-bar .btn {
  flex: 0 0 auto;
}

.sheet-card-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.sheet-card-title strong {
  color: #1e293b;
  font-size: 13.5px;
}

.sheet-status {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--primary-bg);
  color: var(--primary-d);
  font-size: 11px;
}

.sheet-status-empty {
  background: #f1f5f9;
  color: #64748b;
}

.sheet-card-metrics {
  display: flex;
  gap: 14px;
  color: var(--muted);
  font-size: 12px;
}

.sheet-card-metrics strong {
  color: var(--teal);
}

.empty-note {
  margin: 12px 0 0;
}

.question-list {
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}

.question-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 0;
  border-top: 1px solid #edf2f7;
}

.question-seq {
  flex: 0 0 24px;
  height: 24px;
  border-radius: 50%;
  background: #f1f5f9;
  color: #475569;
  font-size: 12px;
  display: grid;
  place-items: center;
}

.question-main {
  flex: 1;
  min-width: 0;
}

.question-block {
  border: 1px solid #e4ebf2;
  border-radius: 10px;
  padding: 12px 14px;
}

.question-block-label {
  margin-bottom: 5px;
  color: #64748b;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .04em;
}

.question-block-prompt {
  border-color: #dbe8f2;
  background: #fbfdff;
}

.question-text {
  margin: 0;
  color: #1e293b;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.75;
}

.question-meta {
  display: flex;
  gap: 8px 16px;
  flex-wrap: wrap;
  margin: 11px 2px 0;
  color: var(--muted);
  font-size: 11.5px;
}

.muted-warn {
  color: #b45309;
}

.question-block-answer {
  margin-top: 13px;
  border-color: #e2e8f0;
  background: #f7fafc;
}

.question-answer {
  margin: 0;
  color: #334155;
  font-size: 13px;
  line-height: 1.85;
  overflow-wrap: anywhere;
}

.question-block-ai {
  margin-top: 12px;
  border-color: #cfe2fb;
  background: #f3f8ff;
}

.question-block-ai .question-block-label {
  color: #4d78a3;
}

.question-ai {
  margin: 0;
  color: #315f91;
  font-size: 12.5px;
  line-height: 1.85;
  overflow-wrap: anywhere;
}

.tier-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 17px;
  padding-top: 13px;
  border-top: 1px dashed #dbe4ed;
}

.tier-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 76px;
  gap: 2px;
  border: 1px solid #d8e1ea;
  border-radius: 9px;
  padding: 8px 12px;
  color: #475569;
  font-size: 11.5px;
  transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
}

.tier-btn strong {
  font-size: 13px;
}

.tier-btn span {
  color: currentColor;
  opacity: .72;
  font-size: 10.5px;
}

.tier-excellent {
  border-color: #b9e4c7;
  background: #eaf8ee;
  color: #28764a;
}

.tier-pass {
  border-color: #f0d995;
  background: #fff7dc;
  color: #946f13;
}

.tier-below {
  border-color: #f1c1c5;
  background: #fff0f1;
  color: #ad4d57;
}

.tier-btn:not(:disabled):hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 10px rgba(51, 65, 85, .1);
}

.tier-active {
  box-shadow: 0 0 0 2px rgba(91, 141, 187, .22), 0 4px 10px rgba(51, 65, 85, .1);
}

.score-input {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.score-input input {
  width: 74px;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  padding: 6px 8px;
  color: #1e293b;
}

.score-input span {
  color: var(--muted);
  font-size: 11.5px;
}

.btn-inline {
  padding: 5px 9px;
}

.ai-score-btn {
  border-color: #bcdcf7;
  background: #e7f3ff;
  color: #2d6798;
}

.ai-score-btn:not(:disabled):hover {
  border-color: #a8ceef;
  background: #d9ecff;
  color: #24587f;
}

.question-delete {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: #dc5b69;
  color: #fff;
  font-size: 11.5px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
  box-shadow: 0 5px 12px rgba(220, 91, 105, .2);
  transition: background .18s ease, transform .18s ease, box-shadow .18s ease;
}

.question-delete:hover {
  background: #c94758;
  transform: translateY(-1px);
  box-shadow: 0 7px 15px rgba(220, 91, 105, .28);
}

.question-delete:disabled {
  opacity: .58;
  cursor: wait;
  transform: none;
}

.comment-row {
  margin-top: 8px;
}

.comment-row input {
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  padding: 7px 9px;
  color: #1e293b;
  font-size: 12.5px;
}

.question-evidence {
  margin: 7px 0 0;
  padding-left: 18px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.7;
}

.sheet-card-foot {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #edf2f7;
}

.manual-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 10px;
}

.manual-form .form-wide {
  grid-column: 1 / -1;
}

.manual-form .dialog-buttons {
  grid-column: 1 / -1;
}

@media (max-width: 900px) {
  .manual-form {
    grid-template-columns: 1fr;
  }
}
</style>
