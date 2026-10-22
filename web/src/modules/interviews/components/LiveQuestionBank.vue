<script setup lang="ts">
import { computed } from 'vue'
import type { GeneratedInterviewQuestion } from '../api'
import { commonGroupsForRound } from '../utils/common-question-templates'
const props = withDefaults(defineProps<{ questions: GeneratedInterviewQuestion[]; currentQuestion: string; round: number; disabled?: boolean; engine?: string; followUps?: string[]; group?: 'ai' | 'hr' | 'department' | 'boss' }>(), { disabled: false, engine: '', followUps: () => [] })
const emit = defineEmits<{ select: [question: string, source: 'manual' | 'ai_adopted'] }>()
const resumeQuestions = computed(() => props.questions.filter(question => !question.group || question.group === 'ai'))
const groups = computed(() => commonGroupsForRound(props.round).filter(group => !props.group || group.id === props.group).map(group => {
  const generated = props.questions.filter(question => question.group === group.id)
  if (!generated.length) return { ...group, generated: false }
  return { ...group, title: group.id === 'department' && props.round >= 2 ? '业务通用提问' : group.id === 'boss' ? 'BOSS 通用提问' : group.title, generated: true, description: props.engine === 'local_fallback' ? '本地规则能力参考题，每个维度一道。大模型恢复后可重新生成。' : 'AI 按能力维度生成通用考核题，每个维度一道。模板仅作为能力与评分参考，重新生成可换一批问题。', dimensions: group.dimensions.map(dimension => ({ ...dimension, questions: generated.filter(question => question.dimension === dimension.id).map(question => question.question) })) }
}))
const modelQuestion = (text: string) => props.questions.find(question => normalized(question.question) === normalized(text))
const questionSource = (text: string) => modelQuestion(text) ? 'ai_adopted' as const : 'manual' as const
const normalized = (value: string) => value.replace(/\s+/g, ' ').trim()
const selected = (question: string) => normalized(question) === normalized(props.currentQuestion)
const activeGroup = computed(() => groups.value.find(group => group.dimensions.some(dimension => dimension.questions.some(selected))))
const unlistedCurrentQuestion = computed(() => props.currentQuestion.trim() && !props.questions.some(question => selected(question.question)) && !groups.value.some(group => group.dimensions.some(dimension => dimension.questions.some(selected))) && !props.followUps.some(selected))
const categoryLabels = { technical: '专业技能', behavioral: '行为表现', experience: '经历核实', job_specific: '岗位匹配' }
</script>
<template>
  <div class="question-bank" :class="{ 'reference-bank': group }" aria-label="面试参考题">
    <nav v-if="!group" class="group-links" aria-label="面试题分组定位">
      <a href="#interview-ai-questions">AI 简历题</a><a v-for="group in groups" :key="group.id" :href="'#interview-' + group.id + '-questions'">{{ group.id === 'hr' ? 'HR' : group.id === 'department' ? (round >= 2 ? '业务' : '用人部门') : 'BOSS' }}</a>
    </nav>
    <p v-if="!group" class="bank-note">所有题目已展开，向下滚动查看。点击题目设为当前参考问题，不代表实际已提问；HR、用人部门按能力维度分别展示。旧模板备选题任选其一。{{ activeGroup ? '当前来源：' + activeGroup.title : '' }}</p>
    <section v-if="!group || group === 'ai'" id="interview-ai-questions" class="question-group group-ai" data-group="ai" aria-label="AI 简历针对性提问">
      <header><h3>AI 简历针对性提问</h3><span>{{ resumeQuestions.length }} 题</span></header>
      <p class="group-description">依据候选人简历证据与岗位要求生成，重点核实经历、成果、能力与待确认信息。</p>
      <p v-if="engine === 'local_fallback'" class="fallback-note">当前使用本地规则生成，并非大模型结果。</p>
      <p v-if="!resumeQuestions.length" class="group-empty">{{ props.group ? '简历针对性题目尚未就绪。' : '简历针对性题目尚未就绪，下面的通用模板仍可使用。' }}</p>
      <article v-for="(question, index) in resumeQuestions" :key="index + ':' + question.question" class="question-item" :class="{ selected: selected(question.question) }">
        <div class="question-meta"><span>AI · {{ index + 1 }} · {{ categoryLabels[question.category] }}</span><b v-if="selected(question.question)">已选参考</b></div>
        <button class="question-select" type="button" :disabled="disabled" :aria-pressed="selected(question.question)" @click="emit('select', question.question, 'ai_adopted')">{{ question.question }}</button>
        <details v-if="question.groundedIn.length || question.rationale || question.scoringRubric.length" class="question-reference" :open="Boolean(props.group)"><summary>简历依据与考察点</summary><p v-if="question.groundedIn.length"><strong>依据：</strong>{{ question.groundedIn.join('；') }}</p><p v-if="question.rationale">{{ question.rationale }}</p><ul v-if="question.scoringRubric.length"><li v-for="(rubric, rubricIndex) in question.scoringRubric" :key="rubricIndex">{{ rubric.criterion }}（{{ rubric.points }} 分）</li></ul></details>
      </article>
      <article v-for="(question, index) in followUps" :key="question" class="question-item follow-up" :class="{ selected: selected(question) }"><div class="question-meta"><span>AI 追问建议 · {{ index + 1 }}</span><b v-if="selected(question)">已选参考</b></div><button class="question-select" type="button" :disabled="disabled" :aria-pressed="selected(question)" @click="emit('select', question, 'ai_adopted')">{{ question }}</button></article>
    </section>
    <section v-for="group in groups" :id="'interview-' + group.id + '-questions'" :key="group.id" class="question-group" :class="'group-' + group.id" :data-group="group.id" :aria-label="group.title">
      <header><h3>{{ group.title }}</h3><span>{{ group.generated ? (engine === 'local_fallback' ? '本地规则 · 5 题' : 'AI 生成 · 5 题') : '模板参考' }} · 满分 {{ group.maxScore }}</span></header><p class="group-description">{{ group.description }}</p>
      <p v-if="!group.generated" class="fallback-note">这里是原模板参考题，并非 AI 随机生成。请点击重新生成题库获取新的能力考核题。</p>
      <p v-if="group.generated && engine === 'local_fallback'" class="fallback-note">模型生成未成功，当前为本地规则参考题，并非大模型随机结果。</p>
      <article v-for="(dimension, index) in group.dimensions" :key="dimension.id" class="template-dimension">
        <h4>{{ index + 1 }}. {{ dimension.title }}<small>{{ dimension.maxScore }} 分</small></h4><p class="dimension-focus">考察：{{ dimension.focus }}</p>
        <div v-for="(question, questionIndex) in dimension.questions" :key="question" class="question-item" :class="{ selected: selected(question) }"><div class="question-meta"><span>{{ group.generated ? (engine === 'local_fallback' ? '本地规则题' : 'AI 能力考核题') : dimension.questions.length > 1 ? '备选 ' + (questionIndex + 1) : '模板题' }}</span><b v-if="selected(question)">已选参考</b></div><button class="question-select" type="button" :disabled="disabled" :aria-pressed="selected(question)" @click="emit('select', question, questionSource(question))">{{ question }}</button><details v-if="modelQuestion(question)" class="question-reference" :open="Boolean(props.group)"><summary>本题生成依据与评分要点</summary><p>{{ modelQuestion(question)?.rationale }}</p><p>依据：{{ modelQuestion(question)?.groundedIn.join('；') }}</p><ul><li v-for="(rubric, rubricIndex) in modelQuestion(question)?.scoringRubric" :key="rubricIndex">{{ rubric.criterion }}（{{ rubric.points }} 分）</li></ul></details></div>
        <details class="question-reference" :open="Boolean(props.group)"><summary>评分参考（不自动计分）</summary><p class="reference-range">{{ group.id === 'hr' ? '优秀 8 分 · 合格 6～7 分 · 待核实 ≤5 分' : group.id === 'department' ? '优秀 8～10 分 · 合格 6～7 分 · 待核实 ≤5 分；原模板每维度满分 12 分' : '优秀 17～20 分 · 合格 12～16 分 · 待核实 ≤11 分' }}</p><p><strong>优秀：</strong>{{ dimension.excellent }}</p><p><strong>合格：</strong>{{ dimension.pass }}</p><p><strong>待核实：</strong>{{ dimension.warning }}</p></details>
      </article>
    </section>
    <article v-if="!group && unlistedCurrentQuestion" class="question-item selected current-custom-question"><div class="question-meta"><span>当前参考问题</span><b>已选参考</b></div><button class="question-select" type="button" :disabled="disabled" aria-pressed="true" @click="emit('select', currentQuestion, questionSource(currentQuestion))">{{ currentQuestion }}</button></article>
  </div>
</template>
<style scoped>
.question-bank{padding:0 14px 14px;min-width:0}.group-links{position:sticky;top:0;z-index:2;padding:8px 0;background:#fff;display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}.group-links a{padding:5px 8px;border:1px solid #dbe8ee;border-radius:6px;background:#f6fafc;color:#41667c;font-size:11px;text-decoration:none}.group-links a:hover{background:#e8f4fa}.bank-note{margin:8px 0 12px;font-size:11px;line-height:1.6;color:#718797}.question-group{scroll-margin-top:52px;margin-bottom:14px;border:1px solid #d8e7ef;border-radius:10px;overflow:hidden;background:#fcfeff}.question-group>header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;padding:12px;background:#edf6ff}.question-group h3{margin:0;font-size:13px;color:#386a98}.question-group>header>span{font-size:11px;color:#667c8b}.group-hr>header{background:#eaf8f2}.group-hr h3{color:#287b62}.group-department>header{background:#eef2ff}.group-department h3{color:#5866a4}.group-boss>header{background:#fff5e8}.group-boss h3{color:#9c743a}.group-description,.group-empty,.fallback-note{margin:9px 12px;font-size:11px;line-height:1.6;color:#708598}.fallback-note{color:#9c743a}.question-item{margin:10px;padding:10px;border:1px solid #e3edf3;border-radius:8px;background:#fff}.question-item.selected{border-color:#62b4a3;background:#f0faf7;box-shadow:0 0 0 1px #62b4a333}.question-meta{display:flex;justify-content:space-between;flex-wrap:wrap;gap:5px;margin-bottom:5px;color:#8a9ca9;font-size:10px}.question-meta b{color:#27806a;font-weight:500}.question-select{display:block;width:100%;padding:0;border:0;background:transparent;color:#365269;text-align:left;font:inherit;font-size:13px;line-height:1.8;cursor:pointer;white-space:pre-wrap;overflow-wrap:anywhere}.question-select:hover{color:#0f766e}.question-select:focus-visible{outline:2px solid #62b4a3;outline-offset:3px;border-radius:3px}.question-select:disabled{cursor:not-allowed;opacity:.65}.question-reference{padding-top:8px;font-size:11px;line-height:1.7;color:#6f8392}.question-reference summary{cursor:pointer;color:#5b8295}.question-reference p{margin:7px 0}.question-reference ul{margin:7px 0;padding-left:18px}.template-dimension{padding:10px 0;border-top:1px solid #e6eef3}.template-dimension h4{display:flex;justify-content:space-between;gap:8px;margin:0 12px 5px;font-size:12px;color:#466273}.template-dimension h4 small{white-space:nowrap;color:#7e949f;font-size:10px;font-weight:400}.dimension-focus{margin:0 12px;font-size:11px;line-height:1.6;color:#8396a3}.template-dimension>.question-reference{margin:0 12px}.follow-up{border-style:dashed}
.reference-bank{padding:0}.reference-bank .question-group{border:0;border-radius:0;background:transparent;margin:0 0 20px;overflow:visible}
.reference-bank .question-group>header{padding:12px 14px;border-bottom:1px solid #d8e7ef}.reference-bank .question-group h3{font-size:14px}
.reference-bank .group-description,.reference-bank .fallback-note,.reference-bank .group-empty{font-size:12px;margin:12px 0}
.reference-bank .question-item{margin:0;padding:16px 14px;border:0;border-bottom:1px solid #e2e8f0;border-radius:0;box-shadow:none;background:transparent}
.reference-bank .question-item.selected{background:#f0faf7;box-shadow:inset 3px 0 #32977f}.reference-bank .question-meta{font-size:11px}.reference-bank .question-select{font-size:14px;line-height:1.8}
.reference-bank .question-reference{font-size:12px;color:#526878;overflow-wrap:anywhere}.reference-bank .question-reference summary{font-weight:500;color:#476578}
.reference-bank .template-dimension{padding:18px 0;border-top:0;border-bottom:1px solid #d8e7ef}.reference-bank .template-dimension h4{margin:0 14px 8px;font-size:14px}.reference-bank .template-dimension h4 small{font-size:11px}
.reference-bank .dimension-focus{font-size:12px;margin:0 14px 4px}.reference-bank .template-dimension .question-item{border-bottom:0;padding:12px 14px}.reference-bank .template-dimension>.question-reference{padding:10px 14px;margin:0;background:#f8fafb}.reference-bank .follow-up{border-style:solid}
@media(min-width:800px){.reference-bank .group-ai>.question-item:not(.follow-up){display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);column-gap:28px}.reference-bank .group-ai .question-meta{grid-column:1/-1}.reference-bank .group-ai .question-reference{padding-top:0}}
</style>
