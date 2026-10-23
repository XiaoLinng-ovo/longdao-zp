<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { InterviewQuestionConversationMessage } from '../api'

const props = withDefaults(defineProps<{
  group: 'ai' | 'hr' | 'department' | 'boss'
  selectedQuestion?: string
  messages: InterviewQuestionConversationMessage[]
  loading?: boolean
  disabled?: boolean
  blocked?: boolean
  error?: string
}>(), { loading: false, disabled: false, blocked: false, error: '' })

const emit = defineEmits<{ send: [content: string]; cancel: [] }>()
const draft = ref('')
const input = ref<HTMLTextAreaElement>()
const messageList = ref<HTMLElement>()
const retryContent = computed(() => props.messages.at(-1)?.role === 'user' ? props.messages.at(-1)?.content : '')
const groupLabel = computed(() => ({ ai: 'AI 简历题', hr: 'HR 面试表', department: '用人部门面试表', boss: 'BOSS 面试表' })[props.group])

function submit() {
  const content = draft.value.trim()
  if (!content || props.loading || props.disabled || props.blocked) return
  emit('send', content)
  draft.value = ''
}

function onInputKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}

async function focusInput() {
  await nextTick()
  if (!props.loading && !props.disabled) input.value?.focus()
}

watch(() => props.messages.length, () => { void focusInput() })
watch(() => [props.messages.length, props.loading], async () => { await nextTick(); messageList.value?.scrollTo?.({ top: messageList.value.scrollHeight }) })
</script>

<template>
  <aside class="question-conversation" aria-label="AI 对话调整面试题">
    <header class="conversation-header">
      <div>
        <span class="conversation-eyebrow">AI 协作调整</span>
        <h3>{{ selectedQuestion ? '修改选中题目' : '调整整张面试表' }}</h3>
        <p>{{ groupLabel }} · {{ selectedQuestion ? '仅修改 1 题' : '全部题目' }}</p>
      </div>
      <span class="conversation-status" :class="{ active: loading }" role="status"><i aria-hidden="true" />{{ loading ? '生成中' : '可调整' }}</span>
    </header>
    <p v-if="selectedQuestion" class="conversation-selection" :title="selectedQuestion">{{ selectedQuestion }}</p>
    <div ref="messageList" class="conversation-messages" aria-live="polite">
      <div v-if="!messages.length" class="conversation-empty"><span class="empty-icon" aria-hidden="true">✦</span><strong>告诉 AI 你想怎么调整</strong><p>例如：增加对项目复盘的追问、降低技术难度、让问题更贴合管理岗位。</p></div>
      <article v-for="(message, index) in messages" :key="index + ':' + message.role + ':' + message.content" class="conversation-message" :class="message.role">
        <span class="message-role">{{ message.role === 'user' ? '你' : 'AI' }}</span><p>{{ message.content }}</p>
      </article>
      <div v-if="loading" class="conversation-message assistant pending" role="status"><span class="message-role">AI</span><p><span class="typing-dots"><i /><i /><i /></span> 正在根据你的要求生成新的题目…</p></div>
    </div>
    <div v-if="error" class="conversation-error" role="alert">{{ error }} <button v-if="retryContent && !loading && !disabled && !blocked" type="button" class="conversation-retry" @click="emit('send', retryContent)">重试</button></div>
    <form class="conversation-composer" @submit.prevent="submit">
      <label for="question-conversation-input">{{ selectedQuestion ? '单题修改要求' : '整表调整要求' }}</label>
      <textarea id="question-conversation-input" ref="input" v-model="draft" :disabled="disabled || loading || blocked" maxlength="1200" rows="3" :placeholder="selectedQuestion ? '输入这道题的修改要求…' : '输入整张面试表的调整要求…'" @keydown="onInputKeydown" />
      <div class="composer-actions"><small>{{ blocked ? '正在生成题库' : draft.length + '/1200' }}</small><button v-if="loading" class="conversation-button cancel" type="button" @click="emit('cancel')">取消生成</button><button v-else class="conversation-button send" type="submit" :disabled="disabled || blocked || !draft.trim()">发送</button></div>
    </form>
    <p v-if="disabled" class="conversation-disabled">面试已结束，只能查看已保存题库。</p>
  </aside>
</template>

<style scoped>
.question-conversation{display:flex;flex-direction:column;min-height:0;height:100%;border:1px solid #dbe9ee;border-radius:12px;background:#fbfeff;overflow:hidden}.conversation-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid #e1edf1;background:linear-gradient(135deg,#f0fbfa,#f7fbff)}.conversation-eyebrow{display:block;margin-bottom:5px;color:#5a9a93;font-size:10px;font-weight:700;letter-spacing:.08em}.conversation-header h3{margin:0;color:#31546a;font-size:15px;line-height:1.4}.conversation-header p{margin:5px 0 0;color:#78909d;font-size:11px;line-height:1.6}.conversation-status{display:inline-flex;align-items:center;gap:5px;flex:none;padding:5px 8px;border:1px solid #d7e9e7;border-radius:999px;background:#f2fbf8;color:#5b8a84;font-size:10px}.conversation-status i{width:6px;height:6px;border-radius:50%;background:#73b8aa}.conversation-status.active i{animation:conversation-pulse 1.1s ease-in-out infinite;background:#4da79a}.conversation-messages{flex:1;min-height:160px;overflow-y:auto;padding:14px;background:#f9fcfd}.conversation-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:190px;padding:20px;text-align:center;color:#6d8793}.empty-icon{display:grid;place-items:center;width:34px;height:34px;margin-bottom:10px;border-radius:10px;background:#e4f5f1;color:#4c9b8e;font-size:17px}.conversation-empty strong{font-size:13px;color:#466777}.conversation-empty p{max-width:250px;margin:7px 0 0;font-size:11px;line-height:1.7}.conversation-message{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;align-items:start;margin:0 0 11px}.conversation-message:last-child{margin-bottom:0}.message-role{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:#e5f5f2;color:#438d82;font-size:10px;font-weight:700}.conversation-message.user .message-role{background:#eaf1fb;color:#5778a2}.conversation-message p{margin:0;padding:9px 11px;border:1px solid #dfecef;border-radius:4px 11px 11px 11px;background:#fff;color:#456273;font-size:12px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}.conversation-message.user p{border-color:#dce8f5;background:#f1f6fd;border-radius:11px 4px 11px 11px}.conversation-message.pending p{color:#78909d}.typing-dots{display:inline-flex;gap:3px;vertical-align:middle}.typing-dots i{width:4px;height:4px;border-radius:50%;background:#78aea7;animation:conversation-bounce 1s infinite ease-in-out}.typing-dots i:nth-child(2){animation-delay:.15s}.typing-dots i:nth-child(3){animation-delay:.3s}.conversation-error{margin:0;padding:8px 14px;border-top:1px solid #f1d8d8;background:#fff7f7;color:#b45f63;font-size:11px;line-height:1.5}.conversation-composer{padding:12px 14px 14px;border-top:1px solid #e1edf1;background:#fff}.conversation-composer label{display:block;margin-bottom:6px;color:#567280;font-size:11px;font-weight:600}.conversation-composer textarea{display:block;width:100%;min-height:76px;box-sizing:border-box;resize:vertical;padding:10px 11px;border:1px solid #cfe1e6;border-radius:9px;background:#fbfeff;color:#385668;font:inherit;font-size:12px;line-height:1.6;outline:none}.conversation-composer textarea::placeholder{color:#9aadb7}.conversation-composer textarea:focus{border-color:#73b8ae;box-shadow:0 0 0 3px #73b8ae22}.conversation-composer textarea:disabled{cursor:not-allowed;background:#f3f7f8;color:#9aadb7}.composer-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}.composer-actions small{color:#91a4ae;font-size:10px}.conversation-button{min-width:74px;height:30px;padding:0 13px;border:1px solid transparent;border-radius:7px;font:inherit;font-size:11px;cursor:pointer;transition:transform .16s ease,box-shadow .16s ease,background .16s ease}.conversation-button:hover:not(:disabled){transform:translateY(-1px)}.conversation-button:active:not(:disabled){transform:translateY(0) scale(.98)}.conversation-button:focus-visible{outline:2px solid #61a99e;outline-offset:2px}.conversation-button.send{background:#6bb6aa;color:#fff;box-shadow:0 4px 10px #6bb6aa33}.conversation-button.send:hover:not(:disabled){background:#5da99d}.conversation-button.cancel{border-color:#dfc7c8;background:#fff7f7;color:#b26468}.conversation-button:disabled{cursor:not-allowed;opacity:.5}.conversation-disabled{margin:0;padding:8px 14px;border-top:1px solid #e1edf1;color:#899ba3;font-size:10px;text-align:center}@keyframes conversation-pulse{0%,100%{opacity:.45;transform:scale(.85)}50%{opacity:1;transform:scale(1.15)}}@keyframes conversation-bounce{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-3px);opacity:1}}
@media(max-width:800px){.question-conversation{height:auto;min-height:420px}.conversation-messages{max-height:280px}}
.question-conversation{height:auto;min-width:0;box-sizing:border-box;border-radius:8px}
.conversation-header,.conversation-composer,.conversation-disabled{flex:none}
.conversation-header>div{min-width:0;overflow-wrap:anywhere}
.conversation-header{padding:12px 14px}
.conversation-selection{flex:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:0;padding:8px 14px;border-bottom:1px solid #dbe9ee;background:#eef8f5;color:#416f65;font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.conversation-eyebrow{letter-spacing:0}
.conversation-messages{min-height:0;overscroll-behavior:contain}
.conversation-error{flex:none;max-height:72px;overflow-y:auto;overflow-wrap:anywhere}
.conversation-retry{margin-left:6px;padding:2px 6px;border:1px solid #dfc7c8;border-radius:4px;background:#fff;color:inherit;font:inherit;cursor:pointer}
.conversation-composer textarea{resize:none;min-height:60px;height:80px;max-height:100px;border-radius:6px}
.conversation-empty{min-height:120px;box-sizing:border-box}
@media(max-width:800px){.question-conversation{height:460px;min-height:0}.conversation-messages{max-height:none}}
@media(min-width:801px) and (max-height:640px){.conversation-header{padding:10px 14px}.conversation-header p{display:none}.conversation-composer{padding:8px 12px}.conversation-composer textarea{height:60px}}
</style>
