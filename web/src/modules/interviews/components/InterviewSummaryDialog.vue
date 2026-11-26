<script setup lang="ts">
import { onUnmounted, watch } from 'vue'
import InterviewSummaryPanel from './InterviewSummaryPanel.vue'
import type { InterviewStage } from '../api/question-sheets'
const props = defineProps<{ open: boolean; interviewId: string; applicationId?: string; stage?: InterviewStage; candidateName?: string; jobTitle?: string; interviewDate?: string }>()
const emit = defineEmits<{ (event: 'close'): void }>()
let bodyOverflow = ''
let ownsScrollLock = false
function keydown(event: KeyboardEvent) { if (event.key === 'Escape') emit('close') }
function release() {
  document.removeEventListener('keydown', keydown)
  if (ownsScrollLock) document.body.style.overflow = bodyOverflow
  ownsScrollLock = false
}
watch(() => props.open, open => {
  if (!open) { release(); return }
  bodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  ownsScrollLock = true
  document.addEventListener('keydown', keydown)
}, { immediate: true })
onUnmounted(release)
</script>
<template>
  <div v-if="open" class="overlay summary-overlay" role="presentation" @click.self="emit('close')">
    <InterviewSummaryPanel v-bind="props" :embedded="false" @close="emit('close')" />
  </div>
</template>
<style scoped>
.summary-overlay { padding: 20px; z-index: 65; }
@media(max-width: 600px) { .summary-overlay { padding: 8px; } }
</style>
