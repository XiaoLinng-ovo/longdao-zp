<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  createOffer,
  getOffer,
  listOfferContextRows,
  listOffers,
  loadApplicationsForOffer,
  offerAction,
  updateOffer,
  OFFER_ACTION_LABEL,
  OFFER_STATUS_LABEL,
  offerStatusCode,
  type ApiApplication,
  type ApiOfferVersion,
  type OfferAction,
  type OfferStatus,
  type OfferDetail,
  type OfferRow,
} from '../api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { applicationOptionLabel, employmentTypeLabel } from '../../../shared/utils/labels'
import { loadDepartments, type ApiDepartment } from '../../requisitions/api'
import { loadJobs, type JobView } from '../../jobs/api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import PageFeedback from '../../../shared/components/workflow/PageFeedback.vue'
import OfferTable from '../components/OfferTable.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'

const rows = ref<OfferRow[]>([])
const loading = ref(true)
const error = ref('')
const feedback = ref('')
const actingId = ref('')

const applications = ref<ApiApplication[]>([])
const departments = ref<ApiDepartment[]>([])
const jobs = ref<JobView[]>([])
const detailApplicationCode = ref('')
const showCreate = ref(false)
const creating = ref(false)
const createForm = ref({
  applicationId: '',
  jobId: '',
  positionTitle: '',
  departmentId: '',
  employmentType: 'full_time',
  startDate: '',
  baseSalaryAmount: 0,
  currency: 'CNY',
  bonusAmount: 0,
  equity: '',
  benefitsText: '',
  content: '',
})

const detail = ref<OfferDetail | null>(null)
const showDetail = ref(false)
const selectedCandidate = ref('')
const selectedJob = ref('')

const reviseTarget = ref<OfferRow | null>(null)
const showRevise = ref(false)
const revising = ref(false)
const reviseForm = ref({
  jobId: '',
  positionTitle: '',
  departmentId: '',
  employmentType: 'full_time',
  startDate: '',
  baseSalaryAmount: 0,
  currency: 'CNY',
  bonusAmount: 0,
  equity: '',
  benefitsText: '',
  content: '',
})

function clearFlags() { error.value = ''; feedback.value = '' }

async function refresh() {
  loading.value = true
  clearFlags()
  try {
    rows.value = await listOfferContextRows()
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取 Offer 失败').message
  } finally {
    loading.value = false
  }
}

async function ensureApplications() {
  if (applications.value.length && jobs.value.length) return
  try {
    const [apps, depts, jobRows] = await Promise.all([loadApplicationsForOffer(), loadDepartments().catch(() => []), loadJobs().catch(() => [])])
    applications.value = apps
    departments.value = depts
    jobs.value = jobRows
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取申请失败').message
  }
}

/** 岗位只能从已有岗位中选择：选中后带出岗位名称与所属部门，避免手写产生对不上的数据。 */
function applyJobSelection(target: 'create' | 'revise', jobId: string) {
  const job = jobs.value.find((item) => item.id === jobId)
  const form = target === 'create' ? createForm.value : reviseForm.value
  form.jobId = jobId
  if (!job) return
  form.positionTitle = job.title
  const department = departments.value.find((item) => item.name === job.department)
  if (department) form.departmentId = department.id
}

function resetCreateForm() {
  createForm.value = {
    applicationId: '',
    jobId: '',
    positionTitle: '',
    departmentId: '',
    employmentType: 'full_time',
    startDate: '',
    baseSalaryAmount: 0,
    currency: 'CNY',
    bonusAmount: 0,
    equity: '',
    benefitsText: '',
    content: '',
  }
}

async function openCreate() {
  clearFlags()
  resetCreateForm()
  showCreate.value = true
  await ensureApplications()
}

function closeCreate() {
  if (creating.value) return
  showCreate.value = false
}

function splitList(text: string): string[] {
  return text.split(/[，,、\n]/).map((s) => s.trim()).filter(Boolean)
}

async function submitCreate() {
  if (creating.value) return
  const form = createForm.value
  if (!form.applicationId.trim()) { error.value = '请选择申请'; return }
  if (!form.positionTitle.trim()) { error.value = '请填写职位名称'; return }
  if (!form.departmentId.trim()) { error.value = '请填写部门'; return }
  if (!(form.baseSalaryAmount > 0)) { error.value = '请填写有效的月薪/年薪'; return }
  if (!form.content.trim()) { error.value = '请填写 Offer 内容'; return }

  creating.value = true
  clearFlags()
  try {
    await createOffer({
      applicationId: form.applicationId,
      positionTitle: form.positionTitle.trim(),
      departmentId: form.departmentId.trim(),
      employmentType: form.employmentType,
      startDate: form.startDate || undefined,
      baseSalary: { amount: form.baseSalaryAmount, currency: form.currency },
      bonus: form.bonusAmount > 0 ? { amount: form.bonusAmount, currency: form.currency } : undefined,
      equity: form.equity.trim() || undefined,
      benefits: splitList(form.benefitsText),
      content: form.content.trim(),
    })
    feedback.value = 'Offer 草稿已创建'
    showCreate.value = false
    await refresh()
  } catch (cause) {
    error.value = describeApiFailure(cause, '创建 Offer 失败').message
  } finally {
    creating.value = false
  }
}

async function runAction(row: OfferRow, action: OfferAction, reason?: string) {
  if (actingId.value) return
  actingId.value = row.entityId
  clearFlags()
  try {
    const updated = await offerAction(row.entityId, action, reason)
    const nextStatus = updated && typeof updated === 'object' && 'status' in updated
      ? (offerStatusCode(updated) ?? (updated as { status: unknown }).status as OfferStatus)
      : row.status
    feedback.value = `${OFFER_ACTION_LABEL[action]}成功，当前状态 ${OFFER_STATUS_LABEL[nextStatus] ?? nextStatus}`
    await refresh()
  } catch (cause) {
    error.value = describeApiFailure(cause, 'Offer 操作失败').message
  } finally {
    actingId.value = ''
  }
}

async function openDetail(row: OfferRow) {
  clearFlags()
  selectedCandidate.value = row.candidate
  selectedJob.value = row.job
  detailApplicationCode.value = ''
  showDetail.value = true
  detail.value = null
  try {
    detail.value = await getOffer(row.entityId)
    await ensureApplications()
    detailApplicationCode.value = applications.value.find((app) => app.id === detail.value?.offer.applicationId)?.code || ''
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取 Offer 详情失败').message
  }
}

function openRevise(row: OfferRow) {
  clearFlags()
  reviseTarget.value = row
  reviseForm.value = {
    jobId: '',
    positionTitle: '',
    departmentId: '',
    employmentType: 'full_time',
    startDate: '',
    baseSalaryAmount: 0,
    currency: 'CNY',
    bonusAmount: 0,
    equity: '',
    benefitsText: '',
    content: '',
  }
  showRevise.value = true
  getOffer(row.entityId).then((d) => {
    if (!d.version) return
    const comp = d.version.compensation
    reviseForm.value = {
      jobId: jobs.value.find((item) => item.title === d.version?.positionTitle)?.id ?? '',
      positionTitle: d.version.positionTitle,
      departmentId: d.version.departmentId,
      employmentType: d.version.employmentType,
      startDate: d.version.startDate || '',
      baseSalaryAmount: comp.baseSalary?.amount ?? 0,
      currency: comp.baseSalary?.currency ?? 'CNY',
      bonusAmount: comp.bonus?.amount ?? 0,
      equity: comp.equity ?? '',
      benefitsText: (d.version.benefits || []).join('，'),
      content: d.version.content,
    }
  }).catch((cause) => { error.value = describeApiFailure(cause, '读取 Offer 版本失败').message })
}

async function submitRevise() {
  if (revising.value || !reviseTarget.value) return
  const form = reviseForm.value
  if (!form.positionTitle.trim()) { error.value = '请填写职位名称'; return }
  if (!form.departmentId.trim()) { error.value = '请填写部门'; return }
  if (!(form.baseSalaryAmount > 0)) { error.value = '请填写有效的薪资'; return }
  if (!form.content.trim()) { error.value = '请填写 Offer 内容'; return }
  revising.value = true
  clearFlags()
  try {
    await updateOffer(reviseTarget.value.entityId, {
      positionTitle: form.positionTitle.trim(),
      departmentId: form.departmentId.trim(),
      employmentType: form.employmentType,
      startDate: form.startDate || undefined,
      baseSalary: { amount: form.baseSalaryAmount, currency: form.currency },
      bonus: form.bonusAmount > 0 ? { amount: form.bonusAmount, currency: form.currency } : undefined,
      equity: form.equity.trim() || undefined,
      benefits: splitList(form.benefitsText),
      content: form.content.trim(),
    })
    feedback.value = `Offer 草稿已修订（版本 ${reviseTarget.value.entityId}）`
    showRevise.value = false
    await refresh()
  } catch (cause) {
    error.value = describeApiFailure(cause, '修订 Offer 失败').message
  } finally {
    revising.value = false
  }
}

function versionSummary(version?: ApiOfferVersion): string {
  if (!version) return '暂无版本'
  return `${version.positionTitle} · ${employmentTypeLabel(version.employmentType)} · ${version.compensation.baseSalary.amount} ${version.compensation.baseSalary.currency}`
}

onMounted(refresh)
</script>

<template>
  <PageHeader title="Offer 管理" description="创建、审批、发送 Offer，并跟踪候选人响应与入职归档">
    <div class="inline-actions">
      <button class="btn btn-primary" type="button" @click="openCreate">新建 Offer</button>
      <button class="btn btn-ghost" type="button" @click="refresh">刷新</button>
    </div>
  </PageHeader>

  <PageFeedback :feedback="feedback" :error="error" @clear-feedback="feedback = ''" @clear-error="error = ''" />
  <div v-if="loading" class="loading-note">正在读取 Offer...</div>
  <OfferTable v-else :rows="rows" :acting-id="actingId" @action="runAction" @open="openDetail" @revise="openRevise" />

  <div v-if="showCreate" class="overlay" role="presentation" @click.self="closeCreate">
    <div class="dialog offer-create-dialog" role="dialog" aria-modal="true" aria-labelledby="offer-create-title">
      <h3 id="offer-create-title">新建 Offer</h3>
      <div v-if="error" class="error-note">{{ error }}</div>
      <div class="form-grid">
      <div class="form-field">
        <label>申请</label>
        <select v-model="createForm.applicationId">
          <option value="" disabled>选择申请</option>
          <option v-for="app in applications" :key="app.id" :value="app.id">{{ applicationOptionLabel(app) }}</option>
        </select>
      </div>
      <div class="form-field">
        <label>岗位</label>
        <select :value="createForm.jobId" @change="applyJobSelection('create', ($event.target as HTMLSelectElement).value)">
          <option value="" disabled>选择岗位</option>
          <option v-for="job in jobs" :key="job.id" :value="job.id">{{ job.title }}（{{ job.department }}）</option>
        </select>
      </div>
      <div class="form-field"><label>部门</label><select v-model="createForm.departmentId"><option value="" disabled>请选择部门</option><option v-for="dept in departments" :key="dept.id" :value="dept.id">{{ dept.name }}</option></select></div>
      <div class="form-field">
        <label>用工类型</label>
        <select v-model="createForm.employmentType">
          <option value="full_time">全职</option>
          <option value="part_time">兼职</option>
          <option value="internship">实习</option>
        </select>
      </div>
      <div class="form-field"><label>入职日期</label><input v-model="createForm.startDate" type="date" /></div>
      <div class="form-field"><label>薪资（元）</label><input v-model.number="createForm.baseSalaryAmount" type="number" min="0" /></div>
      <div class="form-field"><label>币种</label><input v-model="createForm.currency" /></div>
      <div class="form-field"><label>奖金（元，可选）</label><input v-model.number="createForm.bonusAmount" type="number" min="0" /></div>
      <div class="form-field"><label>股权（可选）</label><input v-model="createForm.equity" placeholder="如 2000 RSU" /></div>
      <div class="form-field" style="grid-column:1 / -1"><label>福利（逗号分隔）</label><input v-model="createForm.benefitsText" placeholder="五险一金、带薪年假" /></div>
      <div class="form-field" style="grid-column:1 / -1"><label>Offer 内容</label><textarea v-model="createForm.content" rows="4"></textarea></div>
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="creating" @click="closeCreate">取消</button>
        <button class="btn btn-primary" type="button" :disabled="creating" @click="submitCreate">{{ creating ? '创建中...' : '创建草稿' }}</button>
      </div>
    </div>
  </div>

  <div v-if="showRevise && reviseTarget" class="overlay" role="presentation" @click.self="showRevise = false">
    <div class="dialog" role="dialog" aria-modal="true" style="max-width:620px">
      <h3>修订 Offer</h3>
      <div class="form-grid">
        <div class="form-field">
          <label>岗位</label>
          <select :value="reviseForm.jobId" @change="applyJobSelection('revise', ($event.target as HTMLSelectElement).value)">
            <option value="" disabled>选择岗位</option>
            <option v-for="job in jobs" :key="job.id" :value="job.id">{{ job.title }}（{{ job.department }}）</option>
          </select>
        </div>
        <div class="form-field"><label>部门</label><select v-model="reviseForm.departmentId"><option value="" disabled>请选择部门</option><option v-for="dept in departments" :key="dept.id" :value="dept.id">{{ dept.name }}</option></select></div>
        <div class="form-field">
          <label>用工类型</label>
          <select v-model="reviseForm.employmentType"><option value="full_time">全职</option><option value="part_time">兼职</option><option value="internship">实习</option></select>
        </div>
        <div class="form-field"><label>入职日期</label><input v-model="reviseForm.startDate" type="date" /></div>
        <div class="form-field"><label>薪资（元）</label><input v-model.number="reviseForm.baseSalaryAmount" type="number" min="0" /></div>
        <div class="form-field"><label>币种</label><input v-model="reviseForm.currency" /></div>
        <div class="form-field"><label>奖金（元，可选）</label><input v-model.number="reviseForm.bonusAmount" type="number" min="0" /></div>
        <div class="form-field"><label>股权（可选）</label><input v-model="reviseForm.equity" /></div>
        <div class="form-field" style="grid-column:1 / -1"><label>福利（逗号分隔）</label><input v-model="reviseForm.benefitsText" /></div>
        <div class="form-field" style="grid-column:1 / -1"><label>Offer 内容</label><textarea v-model="reviseForm.content" rows="4"></textarea></div>
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" :disabled="revising" @click="showRevise = false">取消</button>
        <button class="btn btn-primary" type="button" :disabled="revising" @click="submitRevise">{{ revising ? '保存中...' : '保存修订' }}</button>
      </div>
    </div>
  </div>

  <div v-if="showDetail" class="overlay" role="presentation" @click.self="showDetail = false">
    <div class="dialog" role="dialog" aria-modal="true" style="max-width:560px">
      <h3>Offer 详情</h3>
      <div v-if="detail" class="detail-card" style="margin-top:12px">
        <div class="detail-grid">
          <div class="detail-item"><span>状态</span><StatusTag :status="detail.offer.status" /></div>
          <div class="detail-item"><span>审批</span><StatusTag :status="detail.offer.approval.status" /></div>
          <div class="detail-item"><span>候选人</span><strong>{{ selectedCandidate }}</strong></div>
          <div class="detail-item"><span>岗位</span><strong>{{ selectedJob }}</strong></div>
          <div class="detail-item"><span>审批人</span><strong>{{ detail.offer.approval.approver || '待审批' }}</strong></div>
          <div class="detail-item"><span>版本</span><strong>{{ detail.offer.version }}</strong></div>
          <div class="detail-item" style="grid-column:1 / -1"><span>当前版本内容</span><strong>{{ versionSummary(detail.version) }}</strong></div>
        </div>
        <p v-if="detail.version?.content" class="list-muted" style="margin-top:10px">{{ detail.version.content }}</p>
      </div>
      <p v-else class="list-muted">正在读取详情...</p>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" @click="showDetail = false">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.offer-create-dialog {
  max-width: 860px;
  max-height: min(86vh, 760px);
  overflow-y: auto;
}
</style>




