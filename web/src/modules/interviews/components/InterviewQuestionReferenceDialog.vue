<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import LiveQuestionBank from './LiveQuestionBank.vue'
import InterviewQuestionConversation from './InterviewQuestionConversation.vue'
import type { GeneratedInterviewQuestion, InterviewQuestionConversationMessage } from '../api'

const props = withDefaults(defineProps<{
  group: 'ai' | 'hr' | 'department' | 'boss'
  candidate: string
  job: string
  questions: GeneratedInterviewQuestion[]
  currentQuestion: string
  round: number
  engine: string
  followUps: string[]
  disabled: boolean
  messages?: InterviewQuestionConversationMessage[]
  conversationLoading?: boolean
  conversationError?: string
  conversationBlocked?: boolean
}>(), {
  messages: () => [],
  conversationLoading: false,
  conversationError: '',
  conversationBlocked: false,
})
const emit = defineEmits<{
  close: []
  select: [question: string, source: 'manual' | 'ai_adopted']
  send: [content: string]
  cancel: []
}>()
const title = computed(() => ({ ai: 'AI简历题', hr: 'HR面试表', department: '用人部门面试表', boss: 'BOSS面试表' })[props.group])
const dialog = ref<HTMLElement>()
const closeButton = ref<HTMLButtonElement>()
const previousFocus = document.activeElement as HTMLElement | null
let previousOverflow = ''

function onKeydown(event: KeyboardEvent) {
  if (document.querySelector('.resume-document-dialog[open]')) return
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); return }
  if (event.key !== 'Tab') return
  const focusable = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), summary, a[href], input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])
    .filter(element => element.getClientRects().length > 0)
  const first = focusable[0], last = focusable.at(-1)
  if (!first || !last) { event.preventDefault(); return }
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}

onMounted(() => { previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; closeButton.value?.focus() })
onUnmounted(() => { document.body.style.overflow = previousOverflow; if (previousFocus?.isConnected) previousFocus.focus() })
</script>

<template>
  <div class="reference-overlay" @click.self="emit('close')" @keydown="onKeydown">
    <section ref="dialog" class="reference-dialog" role="dialog" aria-modal="true" aria-labelledby="reference-title">
      <header class="reference-header">
        <div><h3 id="reference-title">{{ title }} <span>参考</span></h3><p>{{ candidate }} · {{ job }} · 第 {{ round }} 轮</p></div>
        <button ref="closeButton" class="reference-close" type="button" aria-label="关闭参考表" title="关闭参考表" @click="emit('close')">×</button>
      </header>
      <div class="reference-body">
        <div v-if="$slots.toolbar" class="reference-toolbar"><slot name="toolbar" /></div>
        <div class="reference-columns">
          <section class="reference-bank-panel" aria-label="当前题库">
            <div class="panel-heading"><span>当前题库</span><small>{{ currentQuestion ? '已选 1 题待修改' : '整表调整' }}</small></div>
            <div class="reference-bank-scroll">
              <LiveQuestionBank selection-mode="edit" :group="group" :questions="questions" :current-question="currentQuestion" :round="round"
                :engine="engine" :follow-ups="[]" :disabled="disabled || conversationLoading || conversationBlocked" @select="(question, source) => emit('select', question, source)" />
            </div>
          </section>
          <InterviewQuestionConversation :group="group" :selected-question="currentQuestion" :messages="messages" :loading="conversationLoading" :error="conversationError" :disabled="disabled" :blocked="conversationBlocked" @send="(content) => emit('send', content)" @cancel="emit('cancel')" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.reference-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.38)}
.reference-dialog{display:flex;flex-direction:column;width:min(1080px,100%);height:min(840px,calc(100dvh - 48px));min-width:0;background:#fff;border:1px solid var(--border);border-radius:8px;box-shadow:0 20px 60px #0f172a33;overflow:hidden}
.reference-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 24px;border-bottom:1px solid var(--border)}
.reference-header h3{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:0;font-size:17px}.reference-header h3 span{font-size:11px;font-weight:400;color:#547165;background:#eef7f2;padding:3px 7px;border-radius:4px}
.reference-header p{margin:6px 0 0;color:var(--text-muted);font-size:12px;overflow-wrap:anywhere}
.reference-close{flex:none;width:32px;height:32px;padding:0;border:1px solid var(--border);border-radius:6px;background:#fff;color:#475569;font-size:23px;line-height:1;cursor:pointer}
.reference-close:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.reference-body{flex:1;min-height:0;overflow:hidden;overscroll-behavior:contain;padding:16px 24px 24px}.reference-columns{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(340px,.85fr);gap:16px;height:100%;min-height:0}.reference-bank-panel{display:flex;flex-direction:column;min-width:0;min-height:0;border:1px solid #dbe9ee;border-radius:12px;background:#fff;overflow:hidden}.panel-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid #e1edf1;background:#f8fbfc;color:#426476;font-size:13px;font-weight:600}.panel-heading small{color:#91a3ad;font-size:10px;font-weight:400}.reference-bank-scroll{min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 14px 14px}
@media(max-width:600px){.reference-overlay{padding:12px}.reference-dialog{height:calc(100dvh - 24px)}.reference-header{padding:14px 16px}.reference-body{padding:12px 16px 20px}}
@media(max-width:800px){.reference-body{overflow-y:auto}.reference-columns{grid-template-columns:1fr;height:auto}.reference-bank-panel{min-height:360px}.reference-bank-scroll{max-height:520px}}
.reference-overlay,.reference-dialog,.reference-body,.reference-columns{box-sizing:border-box}
.reference-header{flex:none}
.reference-overlay{padding:16px}
.reference-dialog{height:min(840px,calc(100dvh - 32px))}
.reference-header{padding:14px 20px}
.reference-body{padding:12px 20px 16px}
.reference-body{display:flex;flex-direction:column}
.reference-toolbar{flex:none;max-height:25%;overflow-y:auto;overflow-wrap:anywhere;margin-bottom:8px}
.reference-columns{flex:1;height:auto;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr)}
.reference-bank-panel{border-radius:8px}
.panel-heading{flex:none;flex-wrap:wrap}
.reference-bank-scroll{flex:1}
@media(max-width:800px){.reference-toolbar{max-height:none;overflow:visible}.reference-columns{flex:none;grid-template-columns:minmax(0,1fr)}.reference-bank-panel{height:420px;min-height:0}}
</style>
