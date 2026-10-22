<script setup lang="ts">
import type { ApiInterviewQuestion, QuestionTierName } from '../api/question-sheets'

defineProps<{
  question: ApiInterviewQuestion
  disabled: boolean
  score: number | ''
  comment: string
}>()
const emit = defineEmits<{
  tier: [value: QuestionTierName]
  scoreInput: [value: string]
  scoreCommit: []
  commentInput: [value: string]
  commentCommit: []
}>()
const labels = { excellent: '优秀', pass: '合格', below: '淘汰信号' }
</script>

<template>
  <div class="criterion-content">
    <header class="criterion-head">
      <div>
        <span class="criterion-eyebrow">考察点 {{ String(question.seq).padStart(2, '0') }}</span>
        <h4>{{ question.question }}</h4>
        <p v-if="question.assessmentFocus">{{ question.assessmentFocus }}</p>
      </div>
      <span class="criterion-maximum">满分 <strong>{{ Math.max(...question.tiers.map(tier => tier.max)) }}</strong> 分</span>
    </header>
    <div class="criterion-scoring">
      <div class="criterion-tiers" role="group" :aria-label="question.question + '评分标准'">
        <button v-for="tier in question.tiers" :key="tier.tier" type="button"
          class="criterion-tier" :class="['criterion-' + tier.tier, { 'tier-active': question.finalTier === tier.tier }]"
          :disabled="disabled" :aria-pressed="question.finalTier === tier.tier" @click="emit('tier', tier.tier)">
          <span class="criterion-tier-heading"><strong>{{ labels[tier.tier] }}</strong><span>{{ tier.min === tier.max ? tier.max : tier.min + '-' + tier.max }} 分</span></span>
          <span class="criterion-description">{{ tier.description }}</span>
        </button>
      </div>
      <div class="criterion-manual">
        <label :for="'criterion-score-' + question.id">人工得分</label>
        <div class="score-input">
          <input :id="'criterion-score-' + question.id" type="number" min="0" step="1"
            :max="Math.max(...question.tiers.map(tier => tier.max))" :value="score" :disabled="disabled"
            :aria-label="question.question + '得分'" placeholder="--"
            @input="emit('scoreInput', ($event.target as HTMLInputElement).value)" @change="emit('scoreCommit')" />
          <span>分</span>
        </div>
        <span class="criterion-saved">{{ question.finalScore === null ? '待评分' : '已保存' }}</span>
      </div>
    </div>
    <div class="criterion-comment comment-row">
      <label :for="'criterion-comment-' + question.id">面试评语</label>
      <input :id="'criterion-comment-' + question.id" :value="comment" :disabled="disabled" placeholder="选填"
        @input="emit('commentInput', ($event.target as HTMLInputElement).value)" @blur="emit('commentCommit')" />
    </div>
  </div>
</template>

<style scoped>
.criterion-content { min-width: 0; width: 100%; }
.criterion-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px; }
.criterion-eyebrow { color: #64857b; font-size: 11px; font-weight: 600; }
.criterion-head h4 { margin: 6px 0 0; font-size: 15px; line-height: 1.6; color: #243b38; }
.criterion-head p { margin: 6px 0 0; font-size: 12px; line-height: 1.7; color: #647572; }
.criterion-maximum { flex-shrink: 0; color: #647572; font-size: 12px; padding-top: 5px; }
.criterion-maximum strong { font-size: 18px; color: #315e53; margin: 0 3px; }
.criterion-scoring { display: grid; grid-template-columns: minmax(0, 1fr) 108px; gap: 22px; }
.criterion-tiers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.criterion-tier { display: flex; flex-direction: column; align-items: stretch; gap: 10px; border: 1px solid transparent; border-radius: 7px; padding: 13px; text-align: left; min-width: 0; font: inherit; cursor: pointer; transition: transform .18s ease, box-shadow .18s ease; }
.criterion-tier-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.criterion-tier-heading strong { font-size: 13px; }
.criterion-description { color: #485c57; font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.criterion-excellent { background: #edf8f0; border-color: #c9e7d1; color: #28724a; }
.criterion-pass { background: #fff8e4; border-color: #f1dfa7; color: #886717; }
.criterion-below { background: #fff0f1; border-color: #f0ced2; color: #a54b55; }
.criterion-tier:not(:disabled):hover { transform: translateY(-2px); box-shadow: 0 4px 10px #263e3212; }
.criterion-tier:not(:disabled):active { transform: translateY(0) scale(.99); }
.criterion-tier.tier-active { box-shadow: 0 0 0 2px currentColor; }
.criterion-tier:focus-visible { outline: 2px solid #387ec0; outline-offset: 3px; }
.criterion-tier:disabled { cursor: default; }
.criterion-manual { display: flex; flex-direction: column; gap: 10px; justify-content: center; border-left: 1px solid #e2ebe7; padding-left: 18px; }
.criterion-manual label { font-size: 12px; font-weight: 600; color: #445e56; }
.score-input { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #647572; }
.score-input input { box-sizing: border-box; min-width: 0; width: 66px; height: 40px; padding: 7px; font-size: 18px; font-weight: 600; border: 1px solid #bdd6cc; border-radius: 6px; color: #285848; background: #fff; }
.score-input input:focus { outline: 2px solid #c5e3d6; outline-offset: 1px; }
.criterion-saved { font-size: 11px; color: #758b80; }
.criterion-comment { display: flex; align-items: center; gap: 16px; margin-top: 18px; }
.criterion-comment label { flex-shrink: 0; font-size: 12px; color: #647572; }
.criterion-comment input { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid #e0e9e5; border-radius: 6px; padding: 9px 11px; font-size: 12px; color: #334b43; background: #fbfdfc; }
@media (max-width: 700px) {
  .criterion-scoring { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .criterion-tiers { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .criterion-manual { flex-direction: row; align-items: center; justify-content: flex-start; border: 0; padding: 0; }
  .criterion-head { gap: 10px; }
}
</style>
