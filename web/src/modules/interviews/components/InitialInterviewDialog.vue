<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { X } from '@lucide/vue'
import { createInterview, loadInterviewScheduleData, INTERVIEW_TYPE_LABEL, type InterviewType, type InterviewerOption } from '../api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'

const props = defineProps<{ applicationId: string }>()
const emit = defineEmits<{ close: []; created: [] }>()
const loading = ref(true)
const saving = ref(false)
const loadError = ref('')
const error = ref('')
const candidateName = ref('')
const jobTitle = ref('')
const interviewers = ref<InterviewerOption[]>([])
const mode = ref<'online' | 'offline'>('online')
const form = ref({ title: '初试', type: 'technical' as InterviewType, scheduledAt: '', meetingUrl: '', location: '', interviewerId: '' })
let disposed = false
let backdropPointerActive = false

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const options = await loadInterviewScheduleData()
    if (disposed) return
    const application = options.applications.find(item => item.id === props.applicationId)
    if (!application) throw new Error('未找到该申请或无权访问，请刷新简历库后重试。')
    if (application.status !== 'interviewing') throw new Error('该申请已不在待面试阶段，请刷新简历库确认最新状态。')
    const candidate = options.candidates.find(item => item.id === application.candidateId)
    const job = options.jobs.find(item => item.id === application.jobId)
    if (!candidate || !job) throw new Error('该申请的候选人或岗位不可用，请刷新简历库核查。')
    candidateName.value = candidate.fullName
    jobTitle.value = job.title
    interviewers.value = options.interviewers
  } catch (cause) {
    if (!disposed) loadError.value = describeApiFailure(cause, '读取申请失败').message
  } finally {
    if (!disposed) loading.value = false
  }
}

function close() { if (!saving.value) emit('close') }

function handleBackdropPointerDown(event: PointerEvent) {
  backdropPointerActive = event.target === event.currentTarget
}

function resetBackdropPointer() {
  backdropPointerActive = false
}

function handleBackdropClick(event: MouseEvent) {
  const closeFromBackdrop = backdropPointerActive && event.target === event.currentTarget
  backdropPointerActive = false
  if (closeFromBackdrop) close()
}

function handleEscape(event: KeyboardEvent) {
  if (event.isComposing) return
  const target = event.target
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
    target.blur()
    return
  }
  close()
}

async function submit() {
  if (loading.value || saving.value || loadError.value) return
  error.value = ''
  if (!form.value.scheduledAt) { error.value = '请选择初试开始时间'; return }
  if (mode.value === 'online' && !form.value.meetingUrl.trim()) { error.value = '请填写线上初试会议链接'; return }
  if (mode.value === 'offline' && !form.value.location.trim()) { error.value = '请填写线下初试地点'; return }
  saving.value = true
  try {
    const interviewer = interviewers.value.find(item => item.id === form.value.interviewerId)
    await createInterview({
      applicationId: props.applicationId,
      round: 1,
      type: form.value.type,
      title: form.value.title.trim() || '初试',
      scheduledStartAt: new Date(form.value.scheduledAt).toISOString(),
      meetingUrl: mode.value === 'online' ? form.value.meetingUrl.trim() : undefined,
      location: mode.value === 'offline' ? form.value.location.trim() : undefined,
      participants: interviewer ? [{ userId: interviewer.id, name: interviewer.displayName, role: 'interviewer', required: true }] : [],
    })
    if (!disposed) emit('created')
  } catch (cause) {
    if (!disposed) error.value = describeApiFailure(cause, '安排面试失败').message
  } finally {
    if (!disposed) saving.value = false
  }
}

onMounted(load)
onUnmounted(() => { disposed = true })
</script>

<template>
  <div class="overlay" role="presentation" @pointerdown="handleBackdropPointerDown" @pointercancel="resetBackdropPointer" @click="handleBackdropClick" @keydown.esc="handleEscape">
    <form class="dialog initial-interview-dialog" role="dialog" aria-modal="true" aria-labelledby="initial-interview-title" @submit.prevent="submit">
      <div class="dialog-heading">
        <h3 id="initial-interview-title">初试邀约</h3>
        <button class="btn btn-ghost close-button" type="button" aria-label="关闭初试邀约" title="关闭" :disabled="saving" @click="close"><X :size="18" /></button>
      </div>
      <div v-if="loading" role="status">正在读取申请与面试官...</div>
      <div v-if="loadError" class="error-note" role="alert">{{ loadError }} <button class="btn btn-ghost" type="button" @click="load">重试</button></div>
      <div v-if="error" class="error-note" role="alert">{{ error }}</div>
      <fieldset :disabled="loading || saving || !!loadError">
        <div class="form-grid">
          <div class="form-field"><label for="initial-candidate">候选人</label><input id="initial-candidate" :value="candidateName" readonly /></div>
          <div class="form-field"><label for="initial-job">岗位</label><input id="initial-job" :value="jobTitle" readonly /></div>
          <div class="form-field"><label for="initial-title">面试标题</label><input id="initial-title" v-model="form.title" placeholder="初试" /></div>
          <div class="form-field"><label for="initial-type">面试类型</label><select id="initial-type" v-model="form.type"><option v-for="(label, value) in INTERVIEW_TYPE_LABEL" :key="value" :value="value">{{ label }}</option></select></div>
          <div class="form-field"><label for="initial-time">开始时间</label><input id="initial-time" v-model="form.scheduledAt" type="datetime-local" /></div>
          <div class="form-field"><label for="initial-mode">初试方式</label><select id="initial-mode" v-model="mode"><option value="online">线上面试</option><option value="offline">线下面试</option></select></div>
          <div v-if="mode === 'online'" class="form-field"><label for="initial-meeting">会议链接</label><input id="initial-meeting" v-model="form.meetingUrl" placeholder="https://..." /></div>
          <div v-else class="form-field"><label for="initial-location">面试地点</label><input id="initial-location" v-model="form.location" placeholder="线下地点" /></div>
          <div class="form-field"><label for="initial-interviewer">面试官（选填）</label><select id="initial-interviewer" v-model="form.interviewerId"><option value="">暂不指定，稍后安排</option><option v-for="person in interviewers" :key="person.id" :value="person.id">{{ person.displayName }}</option></select></div>
        </div>
      </fieldset>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="saving" @click="close">取消</button>
        <button class="btn btn-primary" type="submit" :disabled="loading || saving || !!loadError">{{ saving ? '提交中...' : '创建初试邀约' }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.initial-interview-dialog { max-width: 680px; max-height: calc(100dvh - 40px); overflow-y: auto; border-radius: 8px; }
.dialog-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.dialog-heading h3 { margin: 0; }
.close-button { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; flex-shrink: 0; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.form-field { min-width: 0; }
@media (max-width: 600px) { .form-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
