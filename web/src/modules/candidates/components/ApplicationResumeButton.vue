<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { FileText } from '@lucide/vue'
import { getApplicationResume, type ApiResume } from '../api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import ResumeDocumentDialog from './ResumeDocumentDialog.vue'

const props = defineProps<{ applicationId: string }>()
const loading = ref(false)
const error = ref('')
const resume = ref<ApiResume | null>(null)
let request = 0

watch(() => props.applicationId, () => { request++; loading.value = false; error.value = ''; resume.value = null })
onBeforeUnmount(() => { request++ })

async function open() {
  if (loading.value) return
  const token = ++request
  loading.value = true
  error.value = ''
  try {
    const result = await getApplicationResume(props.applicationId)
    if (token !== request) return
    resume.value = result
    if (!result) error.value = '当前应聘记录未关联简历，请在候选人档案中上传或关联简历。'
  } catch (cause) {
    if (token === request) error.value = describeApiFailure(cause, '读取候选人简历失败，请重试').message
  } finally {
    if (token === request) loading.value = false
  }
}
</script>

<template>
  <span class="application-resume-entry">
    <button class="btn btn-ghost btn-sm resume-entry-button" type="button" title="查看当前应聘的原始简历" aria-haspopup="dialog" :aria-expanded="!!resume" :disabled="loading" :aria-busy="loading" @click="open">
      <FileText :size="16" aria-hidden="true" />{{ loading ? '正在读取...' : '查看简历' }}
    </button>
    <span v-if="error" class="resume-entry-error" role="alert">{{ error }}</span>
    <ResumeDocumentDialog v-if="resume" :candidate-id="resume.candidateId" :resume-id="resume.id" :filename="resume.originalFilename" @close="resume = null" />
  </span>
</template>

<style scoped>
.application-resume-entry{display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0;max-width:100%}
.resume-entry-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;min-height:34px}
.resume-entry-error{font-size:12px;color:var(--danger,#b42318);overflow-wrap:anywhere}
</style>
