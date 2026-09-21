<script setup lang="ts">
import { onUnmounted, watch } from 'vue'
import type { InterviewStage } from '../api/question-sheets'
import QuestionSheetPanel from './QuestionSheetPanel.vue'

const props = defineProps<{ open: boolean; applicationId: string; defaultStage?: InterviewStage }>()
const emit = defineEmits<{ (event: 'close'): void }>()

function close(): void {
  emit('close')
}

/** Esc 关闭整个弹窗；若内层还有「确认阶段结论」弹窗，先让内层处理，避免连关两层。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !props.open) return
  if (document.querySelector('[data-sheet-confirm]')) return
  close()
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      document.addEventListener('keydown', onKeydown)
      document.body.style.overflow = 'hidden'
      return
    }
    document.removeEventListener('keydown', onKeydown)
    document.body.style.overflow = ''
  },
  { immediate: true },
)

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})
</script>

<template>
  <div v-if="open" class="overlay sheet-overlay" role="presentation" @click.self="close">
    <div class="sheet-dialog" role="dialog" aria-modal="true" aria-label="面试问题表">
      <header class="sheet-dialog-head">
        <div>
          <h3>面试问题表</h3>
          <p>综合分公式的权重可调，结论由人确认；向下滚动查看每题的打分明细。</p>
        </div>
        <button class="btn btn-ghost" type="button" @click="close">关闭</button>
      </header>
      <div class="sheet-dialog-body">
        <QuestionSheetPanel :application-id="applicationId" :default-stage="defaultStage" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.sheet-overlay {
  padding: 24px;
  z-index: 60;
}

.sheet-dialog {
  display: flex;
  flex-direction: column;
  width: min(1180px, 96vw);
  max-height: 90vh;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.28);
  overflow: hidden;
}

.sheet-dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  background: #fff;
}

.sheet-dialog-head h3 {
  margin: 0;
  color: #1e293b;
  font-size: 16px;
}

.sheet-dialog-head p {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.sheet-dialog-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 16px 20px 20px;
  background: #f8fafc;
}

.sheet-dialog-body :deep(.form-panel) {
  margin-bottom: 0;
}

@media (max-width: 900px) {
  .sheet-overlay {
    padding: 10px;
  }

  .sheet-dialog {
    width: 100%;
    max-height: 94vh;
  }
}
</style>
