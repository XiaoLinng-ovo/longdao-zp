<script setup lang="ts">
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
</script>

<template>
  <div class="feedback" :class="`feedback-${props.tone}`" role="status" aria-live="polite">
    <span class="feedback-text">{{ props.message }}</span>
    <button v-if="props.dismissible" class="feedback-close" type="button" aria-label="关闭提示" @click="emit('dismiss')">×</button>
  </div>
</template>