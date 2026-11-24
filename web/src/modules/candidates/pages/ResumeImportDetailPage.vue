<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowLeft, ArrowRight, Unlink, RefreshCw } from '@lucide/vue'
import { cancelResumeImportBatch, detachResumeImportJob, getResumeImportBatch, type ApiResumeImportBatch } from '../api'
import { authSession } from '../../auth/session'
import { resumeImportBatchPhase, resumeImportItemStatus } from '../utils/resume-import-progress'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { statusLabel } from '../../../shared/utils/labels'
import PageHeader from '../../../shared/components/PageHeader.vue'

const route = useRoute()
const batch = ref<ApiResumeImportBatch | null>(null)
const loading = ref(false)
const error = ref('')
const actionError = ref('')
const busy = ref(false)
const canManage = computed(() => ['recruiter', 'admin', 'hr_admin'].includes(authSession.user?.role ?? ''))
const canDetach = computed(() => batch.value?.status !== 'uploading' && batch.value?.items.every(item => !['pending', 'uploading', 'queued', 'processing'].includes(resumeImportItemStatus(item))))
const jobLocation = computed(() => ({ name: 'jobs', query: batch.value?.jobId || batch.value?.detachedJobId ? { relatedJobId: batch.value.jobId || batch.value.detachedJobId } : {} }))
async function handleDetach() {
  if (!batch.value?.jobId || busy.value || !canManage.value) return
  if (!window.confirm('确认解除此导入批次与岗位的关联吗？导入历史、候选人、简历和申请均会保留；此批次之后不能继续上传。岗位如仍有候选人申请，需要另行处理。')) return
  busy.value = true
  actionError.value = ''
  try { batch.value = await detachResumeImportJob(batch.value.id) }
  catch (cause) { actionError.value = describeApiFailure(cause, '解除岗位关联失败').message }
  finally { busy.value = false }
}
async function handleCancel() {
  if (!batch.value || busy.value || !window.confirm('确认取消未上传文件吗？已上传的候选人和正在进行的分析会保留。')) return
  busy.value = true
  actionError.value = ''
  try { batch.value = await cancelResumeImportBatch(batch.value.id) }
  catch (cause) { actionError.value = describeApiFailure(cause, '取消上传失败').message }
  finally { busy.value = false }
}
const phase = computed(() => batch.value ? resumeImportBatchPhase(batch.value) : '')
const phaseLabels: Record<string, string> = { uploading: '上传中', waiting_analysis: '等待分析', analyzing: '分析中', completed: '已完成', completed_with_issues: '已结束（有异常）', cancelled: '已取消' }
let requestVersion = 0
async function refresh() {
  const request = ++requestVersion
  const id = String(route.params.id)
  loading.value = true
  error.value = ''
  batch.value = null
  try {
    const result = await getResumeImportBatch(id)
    if (request === requestVersion) batch.value = result
  } catch (cause) {
    if (request === requestVersion) error.value = describeApiFailure(cause, '读取导入批次失败').message
  } finally {
    if (request === requestVersion) loading.value = false
  }
}
const itemStatusLabels: Record<string, string> = { pending: '待上传', uploading: '上传中', queued: '等待分析', processing: '分析中', completed: '已完成', failed: '失败', cancelled: '已取消', removed: '关联申请已删除' }
watch(() => route.params.id, refresh, { immediate: true })
</script>

<template>
  <PageHeader title="简历导入批次">
    <RouterLink class="btn btn-ghost" :to="jobLocation"><ArrowLeft :size="14" aria-hidden="true" /> 返回岗位管理</RouterLink>
    <button v-if="canManage && batch?.jobId && batch.status === 'uploading'" class="btn btn-ghost" type="button" :disabled="busy" @click="handleCancel">取消未上传文件</button>
    <button v-if="canManage && batch?.jobId" class="btn btn-danger" type="button" :disabled="busy || !canDetach" :title="canDetach ? '保留导入历史，解除与岗位的关联' : '请先取消未上传文件，并等待上传和分析结束'" @click="handleDetach"><Unlink :size="14" aria-hidden="true" />{{ busy ? '处理中...' : '解除岗位关联' }}</button>
    <button class="btn btn-ghost" type="button" :disabled="loading || busy" @click="refresh"><RefreshCw :size="14" aria-hidden="true" />刷新</button>
  </PageHeader>
  <div v-if="loading" class="loading-note" role="status">正在读取导入批次...</div>
  <div v-else-if="error" class="error-note" role="alert">{{ error }}</div>
  <template v-else-if="batch">
    <div v-if="actionError" class="error-note" role="alert">{{ actionError }}</div>
    <div v-if="batch.detachedAt" class="success-note" role="status">已解除岗位关联，导入历史及候选人资料已保留。</div>
    <dl class="batch-summary">
      <div><dt>批次状态</dt><dd>{{ phaseLabels[phase] || statusLabel(batch.status) }}</dd></div>
      <div><dt>文件数量</dt><dd>{{ batch.counts.total }}</dd></div>
      <div><dt>创建时间</dt><dd>{{ new Date(batch.createdAt).toLocaleString('zh-CN') }}</dd></div>
      <div><dt>批次编号</dt><dd>{{ batch.id }}</dd></div>
      <div v-if="batch.detachedJobTitle"><dt>原关联岗位</dt><dd>{{ batch.detachedJobTitle }}</dd></div>
    </dl>
    <div class="table-wrap"><table class="batch-files">
      <thead><tr><th>文件名称</th><th>处理状态</th><th>处理结果</th><th>关联业务</th></tr></thead>
      <tbody><tr v-for="item in batch.items" :key="item.id">
        <td class="file-name">{{ item.originalFilename }}</td>
        <td>{{ itemStatusLabels[resumeImportItemStatus(item)] || '状态待确认' }}</td>
        <td class="file-error">{{ item.error || '—' }}</td>
        <td><RouterLink v-if="item.candidateId" class="btn btn-ghost" :to="{ name: 'candidate-detail', params: { id: item.candidateId }, query: item.applicationId ? { applicationId: item.applicationId } : {} }">查看候选人 <ArrowRight :size="14" aria-hidden="true" /></RouterLink><span v-else>未关联候选人</span></td>
      </tr><tr v-if="!batch.items.length"><td colspan="4">此批次没有文件记录。</td></tr></tbody>
    </table></div>
  </template>
</template>

<style scoped>
.batch-summary { display: flex; flex-wrap: wrap; gap: 16px 36px; margin: 0 0 20px; padding: 16px 0; }
.batch-summary div { min-width: 100px; max-width: 100%; }
.batch-summary dt { font-size: 12px; color: #64748b; }
.batch-summary dd { margin: 6px 0 0; overflow-wrap: anywhere; }
.batch-files { width: 100%; min-width: 650px; }
.file-name, .file-error { max-width: 340px; overflow-wrap: anywhere; }
.btn { display: inline-flex; align-items: center; gap: 5px; text-decoration: none; white-space: nowrap; }
</style>
