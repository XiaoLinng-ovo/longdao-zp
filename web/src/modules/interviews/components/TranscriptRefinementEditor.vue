<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import { saveLiveTranscriptRefinement, type AnalysisSourceSegment, type TranscriptRefinement } from '../api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'

const props = defineProps<{
  segmentId: string
  refinement: TranscriptRefinement
  sourceSegments: AnalysisSourceSegment[]
  label: string
  disabled?: boolean
}>()
const emit = defineEmits<{
  saved: [refinement: TranscriptRefinement]
  editingChange: [editing: boolean]
}>()
const editing = ref(false)
const saving = ref(false)
const draft = ref('')
const error = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
let expectedText = ''
let sources: AnalysisSourceSegment[] = []
onBeforeUnmount(() => emit('editingChange', false))

async function edit() {
  expectedText = props.refinement.text
  sources = props.sourceSegments.map(source => ({ ...source }))
  draft.value = expectedText
  error.value = ''
  editing.value = true
  emit('editingChange', true)
  await nextTick()
  textarea.value?.focus()
}
function cancel() {
  editing.value = false
  error.value = ''
  emit('editingChange', false)
}
async function save() {
  if (saving.value || props.disabled || !draft.value.trim() || draft.value.length > 50000) return
  saving.value = true
  error.value = ''
  try {
    const saved = await saveLiveTranscriptRefinement(props.segmentId, draft.value.trim(), expectedText, sources)
    emit('saved', saved)
    cancel()
  } catch (cause) {
    error.value = describeApiFailure(cause, '保存失败，请重试。').message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="refinement-editor">
    <div class="refinement-heading">
      <small class="refined-answer-label">{{ label }}</small>
      <small v-if="refinement.editedAt && !editing" class="edited-status" role="status">已手动编辑</small>
      <button v-if="!editing" class="btn btn-ghost btn-sm" type="button" :disabled="disabled" :aria-label="`编辑${label}`" @click="edit">编辑</button>
    </div>
    <template v-if="editing">
      <textarea ref="textarea" v-model="draft" class="refinement-input" :aria-label="`编辑${label}`" :disabled="saving" maxlength="50000" rows="7" />
      <div class="refinement-actions">
        <small class="character-count">{{ draft.length }} / 50000</small>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="saving" @click="cancel">取消</button>
        <button class="btn btn-primary btn-sm" type="button" :disabled="saving || disabled || !draft.trim() || draft.length > 50000" :aria-busy="saving" @click="save">{{ saving ? '保存中…' : '保存修改' }}</button>
      </div>
      <p v-if="error" class="refinement-error" role="alert">{{ error }}</p>
    </template>
    <p v-else class="refined-answer">{{ refinement.text }}</p>
  </div>
</template>

<style scoped>
.refinement-editor{min-width:0;margin-top:12px}
.refinement-heading{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-height:32px}
.refined-answer-label{color:var(--primary);font-size:12px;font-weight:600}
.refinement-heading button{margin-left:auto}
.edited-status,.character-count{font-size:11px;color:var(--text-muted)}
.refined-answer{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8}
.refinement-input{display:block;box-sizing:border-box;width:100%;min-height:180px;max-height:60vh;margin:8px 0;padding:10px 12px;resize:vertical;overflow:auto;border:1px solid var(--border);border-radius:6px;background:var(--surface,#fff);color:var(--text);font:inherit;line-height:1.8}
.refinement-input:focus{outline:2px solid var(--primary);outline-offset:1px}
.refinement-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px}
.character-count{margin-right:auto}
.refinement-error{margin:8px 0 0;color:#b33a45;font-size:12px;overflow-wrap:anywhere}
</style>
