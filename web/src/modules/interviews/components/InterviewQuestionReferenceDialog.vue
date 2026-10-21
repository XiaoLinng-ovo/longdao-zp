<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import LiveQuestionBank from './LiveQuestionBank.vue'
import type { GeneratedInterviewQuestion } from '../api'

const props = defineProps<{
  group: 'ai' | 'hr' | 'department'
  candidate: string
  job: string
  questions: GeneratedInterviewQuestion[]
  currentQuestion: string
  round: number
  engine: string
  followUps: string[]
  disabled: boolean
}>()
const emit = defineEmits<{ close: []; select: [question: string, source: 'manual' | 'ai_adopted'] }>()
const title = computed(() => ({ ai: 'AI简历题', hr: 'HR面试表', department: '用人部门面试表' })[props.group])
const dialog = ref<HTMLElement>()
const closeButton = ref<HTMLButtonElement>()
const previousFocus = document.activeElement as HTMLElement | null
let previousOverflow = ''

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); return }
  if (event.key !== 'Tab') return
  const focusable = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), summary, a[href], input:not(:disabled), [tabindex="0"]') ?? [])
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
        <slot name="toolbar" />
        <LiveQuestionBank :group="group" :questions="questions" :current-question="currentQuestion" :round="round"
          :engine="engine" :follow-ups="followUps" :disabled="disabled" @select="(question, source) => emit('select', question, source)" />
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
.reference-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:16px 24px 24px}
@media(max-width:600px){.reference-overlay{padding:12px}.reference-dialog{height:calc(100dvh - 24px)}.reference-header{padding:14px 16px}.reference-body{padding:12px 16px 20px}}
</style>
