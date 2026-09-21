<script setup lang="ts">
import { computed } from 'vue'
import {
  STAGE_DECISION_LABEL,
  STAGE_DECISIONS,
  STAGE_LABEL,
  STAGE_RECOMMENDATION_LABEL,
  type ApiStageReview,
  type InterviewStage,
  type StageDecision,
  type StageScoreBreakdown,
  type StageWeights,
} from '../api/question-sheets'
import { fromPercent, toPercent, weightsTotalPercent } from '../utils/stage-score'

const props = defineProps<{
  stage: InterviewStage
  breakdown: StageScoreBreakdown
  draft: StageWeights
  review?: ApiStageReview | null
  dirty?: boolean
  saving?: boolean
  deciding?: boolean
}>()

const emit = defineEmits<{
  (event: 'weight', payload: { key: string; value: number }): void
  (event: 'save'): void
  (event: 'reset'): void
  (event: 'decide', decision: StageDecision): void
}>()

const totalPercent = computed(() => weightsTotalPercent(props.draft, props.stage))
const totalOk = computed(() => Math.abs(totalPercent.value - 100) < 1)
const decisions = computed(() => STAGE_DECISIONS[props.stage])
const recommendationText = computed(() => (props.review?.aiRecommendation ? STAGE_RECOMMENDATION_LABEL[props.review.aiRecommendation] : '暂无 AI 建议'))

function weightOf(key: string): number {
  return key === 'recording' ? props.draft.recording : props.draft.sheets[key] ?? 0
}

function setWeight(key: string, raw: string | number): void {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value) || value < 0) return
  emit('weight', { key, value: fromPercent(value) })
}

function currentDecisionLabel(): string {
  const decision = props.review?.decision
  if (!decision) return '未确认'
  return STAGE_DECISION_LABEL[decision]
}
</script>

<template>
  <section class="stage-score" aria-label="阶段综合分">
    <header class="stage-score-head">
      <div class="stage-score-title">
        <strong>{{ STAGE_LABEL[stage] }}综合分</strong>
        <span class="list-muted">阶段综合分 = Σ(各表得分 × 表权重) + 录音 AI 评分 × 录音权重</span>
      </div>
      <div class="stage-score-value">
        <strong>{{ breakdown.score ?? '—' }}</strong>
        <span>分</span>
        <small v-if="review && review.aiScore !== null && review.aiScore !== breakdown.score">已保存：{{ review.aiScore }}</small>
      </div>
    </header>

    <p class="formula-line" data-testid="stage-formula">{{ breakdown.formula }}</p>

    <table class="weight-table">
      <thead>
        <tr>
          <th>评分项</th>
          <th>得分</th>
          <th>权重（可调）</th>
          <th>实际权重</th>
          <th>贡献</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in breakdown.items" :key="item.key" :class="{ 'row-missing': item.score === null }">
          <td>{{ item.label }}</td>
          <td>{{ item.score ?? '暂无' }}</td>
          <td>
            <label class="weight-input">
              <input
                type="number"
                min="0"
                max="100"
                step="5"
                :value="toPercent(weightOf(item.key))"
                :aria-label="`${item.label}权重`"
                @input="setWeight(item.key, ($event.target as HTMLInputElement).value)"
              />
              <span>%</span>
            </label>
          </td>
          <td>{{ item.effectiveWeight || 0 }}</td>
          <td>{{ item.contribution ?? '—' }}</td>
        </tr>
      </tbody>
    </table>

    <ul v-if="breakdown.notes.length" class="score-notes">
      <li v-for="note in breakdown.notes" :key="note">{{ note }}</li>
    </ul>

    <div class="weight-footer">
      <span :class="totalOk ? 'list-muted' : 'weight-total-warn'">
        权重合计 {{ totalPercent }}%{{ totalOk ? '' : '（需为 100% 才能保存）' }}
      </span>
      <div class="inline-actions">
        <button class="btn btn-ghost" type="button" :disabled="saving" @click="emit('reset')">恢复默认权重</button>
        <button class="btn btn-primary" type="button" :disabled="saving || !totalOk || !dirty" @click="emit('save')">
          {{ saving ? '保存中...' : '保存权重' }}
        </button>
      </div>
    </div>

    <div v-if="review" class="stage-ai">
      <div class="stage-ai-head">
        <strong>AI 建议：{{ recommendationText }}</strong>
        <span class="list-muted">公式给分，AI 给建议；调整权重不会改写建议文本</span>
      </div>
      <p v-if="review.aiRationale">{{ review.aiRationale }}</p>
      <ul v-if="review.aiEvidence.length" class="stage-evidence">
        <li v-for="(evidence, index) in review.aiEvidence.slice(0, 6)" :key="index">{{ evidence }}</li>
      </ul>
    </div>

    <div class="stage-decide">
      <span>阶段结论：{{ currentDecisionLabel() }}</span>
      <small v-if="review?.decidedAt" class="list-muted">{{ new Date(review.decidedAt).toLocaleString('zh-CN') }}</small>
      <div class="inline-actions">
        <button
          v-for="decision in decisions"
          :key="decision"
          class="btn"
          :class="review?.decision === decision ? 'btn-primary' : 'btn-ghost'"
          type="button"
          :disabled="deciding"
          @click="emit('decide', decision)"
        >
          {{ STAGE_DECISION_LABEL[decision] }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.stage-score {
  border: 1px solid var(--border);
  border-left: 3px solid var(--teal);
  border-radius: var(--radius);
  background: #fff;
  box-shadow: var(--shadow);
  padding: 16px 18px;
}

.stage-score-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.stage-score-title {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stage-score-title strong {
  color: #1e293b;
  font-size: 14px;
}

.stage-score-value {
  display: flex;
  align-items: baseline;
  gap: 5px;
  white-space: nowrap;
}

.stage-score-value strong {
  color: var(--teal);
  font-size: 26px;
}

.stage-score-value span,
.stage-score-value small {
  color: var(--muted);
  font-size: 11.5px;
}

.formula-line {
  margin: 12px 0;
  padding: 10px 12px;
  border-radius: 7px;
  background: #f8fafc;
  color: #0f172a;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

.weight-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}

.weight-table th {
  padding: 6px 10px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
}

.weight-table td {
  padding: 7px 10px;
  border-top: 1px solid #edf2f7;
  color: #334155;
  font-size: 12.5px;
}

.row-missing td {
  color: #94a3b8;
}

.weight-input {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.weight-input input {
  width: 74px;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  padding: 5px 8px;
  color: #1e293b;
}

.weight-input span {
  color: var(--muted);
  font-size: 11.5px;
}

.score-notes {
  margin: 10px 0 0;
  padding-left: 18px;
  color: #b45309;
  font-size: 11.5px;
  line-height: 1.7;
}

.weight-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.weight-total-warn {
  color: #b91c1c;
  font-size: 12px;
}

.stage-ai {
  margin-top: 14px;
  padding: 12px;
  border: 1px solid #dbeafe;
  border-radius: 7px;
  background: #f8fbff;
}

.stage-ai-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.stage-ai-head strong {
  color: #1d4ed8;
  font-size: 13px;
}

.stage-ai p {
  margin: 8px 0 0;
  color: #334155;
  font-size: 12.5px;
  line-height: 1.7;
}

.stage-evidence {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.7;
}

.stage-decide {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #edf2f7;
  color: #1e293b;
  font-size: 12.5px;
}

@media (max-width: 900px) {
  .stage-score-head {
    flex-direction: column;
  }
}
</style>
