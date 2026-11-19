<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { contactSystemAdministrator, exportEnterpriseContinuity, getEnterpriseContinuity, type EnterpriseContinuity } from '../api/payments'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import EnterpriseServiceThread from './EnterpriseServiceThread.vue'
import SupportAttachmentPicker from './SupportAttachmentPicker.vue'
import { encodeSupportFiles } from './support-files'
import { jobStatusLabel } from '../../jobs/workflow'
const props = defineProps<{ organizationId: string; initiallyExpanded?: boolean }>()
const expanded = ref(Boolean(props.initiallyExpanded)), loading = ref(false), exporting = ref(false), submitting = ref(false)
const report = ref<EnterpriseContinuity | null>(null), message = ref(''), error = ref(''), notice = ref('')
const openRequest = computed(() => report.value?.requests.find(request => request.status === 'open'))
const files = ref<File[]>([])
let generation = 0
async function load() {
  const current = ++generation, org = props.organizationId
  loading.value = true
  error.value = ''
  try {
    const result = await getEnterpriseContinuity(org)
    if (current === generation) report.value = result
  } catch (cause) {
    if (current === generation) error.value = describeApiFailure(cause, '读取企业服务信息失败').message
  } finally { if (current === generation) loading.value = false }
}
function expand() { expanded.value = !expanded.value; if (expanded.value) void load() }
onMounted(() => { if (expanded.value) void load() })
watch(() => props.initiallyExpanded, value => { if (value && !expanded.value) { expanded.value = true; void load() } })
watch(() => props.organizationId, () => {
  generation++
  report.value = null; message.value = ''; files.value = []; error.value = ''; notice.value = ''
  if (expanded.value) void load()
})
async function submit() {
  if (submitting.value || openRequest.value) return
  const org = props.organizationId
  submitting.value = true; error.value = ''; notice.value = ''
  try {
    const attachments = await encodeSupportFiles(files.value)
    if (props.organizationId !== org) return
    const result = attachments.length ? await contactSystemAdministrator(org, message.value.trim(), attachments) : await contactSystemAdministrator(org, message.value.trim())
    if (props.organizationId !== org) return
    notice.value = result.existing ? '企业已有待处理工单，请在下方会话继续追问；本次内容和附件未提交。' : '工单已提交，可在本页查看系统管理员回复。'
    if (!result.existing) { message.value = ''; files.value = [] }
    await load()
  } catch (cause) {
    if (props.organizationId === org) error.value = describeApiFailure(cause, '提交工单失败').message
  } finally { submitting.value = false }
}
async function download() {
  if (exporting.value) return
  const org = props.organizationId
  exporting.value = true; error.value = ''; notice.value = ''
  try {
    const result = await exportEnterpriseContinuity(org)
    if (props.organizationId !== org) return
    const url = URL.createObjectURL(new Blob([result.csv], {type: 'text/csv;charset=utf-8'}))
    const link = document.createElement('a')
    link.href = url; link.download = result.filename; document.body.append(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    notice.value = `已导出 ${result.rows} 条岗位摘要${result.truncated ? '（已达到 1000 条上限）' : ''}。`
  } catch (cause) {
    if (props.organizationId === org) error.value = describeApiFailure(cause, '导出失败').message
  } finally { exporting.value = false }
}
</script>
<template>
  <section id="enterprise-service" class="enterprise-service" aria-label="企业数据与服务支持">
    <h2>企业数据与服务支持</h2>
    <p>套餐到期后，仍可查看已有岗位摘要、受限导出、联系系统管理员，并在上方续费。创建岗位、上传简历和发起面试需要有效套餐。</p>
    <button type="button" :aria-expanded="expanded" @click="expand">{{ expanded ? '收起服务面板' : '查看已有数据 / 联系系统管理员' }}</button>
    <div v-if="expanded">
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="loading" role="status">正在读取…</p>
      <button v-else type="button" @click="load">刷新数据与回复</button>
      <p v-if="report?.dataRestricted">企业服务已暂停，请通过下方工单联系系统管理员。</p>
      <p v-if="report?.dataUnavailable">企业数据尚未就绪，可通过下方工单联系系统管理员。</p>
      <template v-if="report?.data">
        <h3>已有数据（只读）</h3>
        <p>岗位 {{ report.data.stats.jobs }} · 应聘记录 {{ report.data.stats.applications }} · 面试 {{ report.data.stats.interviews }}</p>
        <p>展示最近 100 条岗位；导出最多 1000 条岗位摘要，包含编号、名称、状态、人数和时间。</p>
        <button type="button" :disabled="exporting || loading" @click="download">{{ exporting ? '正在导出…' : '导出岗位摘要 CSV' }}</button>
        <div class="table-scroll"><table>
          <thead><tr><th>岗位编号</th><th>岗位名称</th><th>状态</th><th>招聘人数</th></tr></thead>
          <tbody><tr v-for="job in report.data.jobs" :key="job.id"><td>{{ job.jobNo }}</td><td>{{ job.title }}</td><td>{{ jobStatusLabel(job.status) }}</td><td>{{ job.headcount }}</td></tr>
          <tr v-if="!report.data.jobs.length"><td colspan="4">暂无已有岗位</td></tr></tbody>
        </table></div>
        <p v-if="report.data.truncated">仅展示最近 {{ report.data.limit }} 条，可导出更多岗位摘要。</p>
      </template>
      <h3>联系系统管理员</h3>
      <p>提交企业服务工单，企业成员可共同查看处理结果。请勿填写支付密钥或候选人敏感信息。</p>
      <form @submit.prevent="submit">
        <label>问题说明<textarea v-model="message" aria-label="问题说明" minlength="2" maxlength="2000" required :disabled="submitting || Boolean(openRequest)" /></label>
        <SupportAttachmentPicker v-model="files" :disabled="submitting || Boolean(openRequest)" />
        <button type="submit" :disabled="submitting || Boolean(openRequest) || message.trim().length < 2">{{ openRequest ? '企业已有待处理工单' : submitting ? '提交中…' : '提交服务工单' }}</button>
      </form>
      <article v-for="request in report?.requests ?? []" :key="request.id">
        <strong>{{ request.status === 'open' ? '待处理' : '已回复' }} · {{ new Date(request.createdAt).toLocaleString('zh-CN') }}</strong>
        <p class="preserve">{{ request.message }}</p>
        <p v-if="request.response" class="preserve">系统管理员回复：{{ request.response }}</p>
        <EnterpriseServiceThread :request-id="request.id" :organization-id="organizationId" @changed="load" />
      </article>
    </div>
  </section>
</template>
<style scoped>
.enterprise-service { margin: 24px 0; padding: 20px; border: 1px solid #d5e2ec; border-radius: 16px; background: #fff; color: #183049; }
h2 { font-size: 20px; } h3 { margin-top: 24px; } p { line-height: 1.7; }
button { padding: 10px 14px; border: 1px solid #bfd2df; border-radius: 8px; background: #f4f8fc; color: #183049; cursor: pointer; }
button:disabled { opacity: .6; cursor: default; }
label { display: grid; gap: 8px; } textarea { min-height: 90px; width: 100%; box-sizing: border-box; padding: 10px; font: inherit; }
form button { margin-top: 10px; } article { margin-top: 16px; padding: 12px; background: #f6f8fb; border-radius: 8px; }
.preserve { white-space: pre-wrap; overflow-wrap: anywhere; } .table-scroll { overflow-x: auto; margin-top: 16px; }
table { border-collapse: collapse; width: 100%; } th, td { padding: 10px; border-bottom: 1px solid #e2e8ef; text-align: left; overflow-wrap: anywhere; }
[role=alert] { color: #a52335; }
</style>
