<script setup lang="ts">
import { computed } from 'vue'
type Tone = 'success' | 'error' | 'info'

const props = withDefaults(defineProps<{
  tone?: Tone
  message: string
  dismissible?: boolean
}>(), {
  tone: 'info',
  dismissible: false,
})

const emit = defineEmits<{ dismiss: [] }>()
const safeMessage = computed(() => {
  const message = props.message
  if (/\[401\]|AUTHENTICATION_REQUIRED|UNAUTHENTICATED/i.test(message)) return '登录状态已失效，请重新登录'
  if (/\[403\]|\bFORBIDDEN\b/i.test(message)) return '当前账号没有执行此操作的权限'
  return message
})
</script>

<template>
  <div class="feedback" :class="`feedback-${props.tone}`" role="status" aria-live="polite">
    <span class="feedback-text">{{ safeMessage }}</span>
    <button v-if="props.dismissible" class="feedback-close" type="button" aria-label="关闭提示" @click="emit('dismiss')">×</button>
  </div>
</template>
