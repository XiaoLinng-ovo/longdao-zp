<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiClient } from '../../../shared/api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import WorkflowEventTable from '../../../shared/components/workflow/WorkflowEventTable.vue'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { employmentTypeLabel } from '../../../shared/utils/labels'
import { loadWorkflowEvents, type WorkflowEvent } from '../../../shared/api/workflow-events'
import {
  getOffer,
  offerAction,
  updateOffer,
  OFFER_ACTION_LABEL,
  OFFER_STATUS_LABEL,
  offerStatusCode,
  type ApiOffer,
  type ApiOfferVersion,
  type OfferAction,
  type OfferStatus,
} from '../api'

const route = useRoute()
const router = useRouter()
const offer = ref<ApiOffer | null>(null)
const currentVersion = ref<ApiOfferVersion | null>(null)
const candidateName = ref('')
const jobTitle = ref('')
const applicationCode = ref('')
const departmentName = ref('')
const loading = ref(true)
const error = ref('')
const feedback = ref('')
const acting = ref(false)
const auditEvents = ref<WorkflowEvent[]>([])
const loadingAudit = ref(false)

const pendingAction = ref<OfferAction | null>(null)
const reason = ref('')

const showRevise = ref(false)
const revising = ref(false)
const jobOptions = ref<Array<{ id: string; title: string; departmentId?: string; department?: string }>>([])
const departmentOptions = ref<Array<{ id: string; code?: string; name: string }>>([])
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

const REASON_ACTIONS: OfferAction[] = ['decline', 'cancel', 'reject']

const availableActions = computed<OfferAction[]>(() => {
  if (!offer.value) return []
  switch (offer.value.status) {
    case 'draft': return ['submit-approval', 'cancel']
    case 'pending_approval': return ['approve', 'reject', 'cancel']
    case 'approved': return ['send', 'cancel']
    case 'sent': return ['accept', 'decline', 'expire', 'cancel']
    case 'accepted': return ['archive-onboarding']
    default: return []
  }
})

function tone(action: OfferAction): string {
  if (action === 'decline' || action === 'cancel' || action === 'reject') return 'btn-danger'
  if (action === 'approve' || action === 'send' || action === 'submit-approval') return 'btn-primary'
  return 'btn-ghost'
}

function clearFlags() { error.value = ''; feedback.value = '' }

async function loadAuditEvents(offerId: string) {
  loadingAudit.value = true
  auditEvents.value = []
  try {
    auditEvents.value = await loadWorkflowEvents('offer', 100).then((rows) => rows.filter((event) => event.subjectId === offerId))
  } catch {
    auditEvents.value = []
  } finally {
    loadingAudit.value = false
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const id = String(route.params.id ?? '')
    if (!id) throw new Error('缺少 Offer ID')
    const detail = await getOffer(id)
    offer.value = detail.offer
    currentVersion.value = detail.version ?? null

    const [applicationRes, candidateRes, jobRes, departmentRes] = await Promise.all([
      apiClient.getJson<Array<{ id: string; code: string; candidateId: string; jobId: string; status: string }>>('/applications'),
      apiClient.getJson<Array<{ id: string; fullName: string; code?: string }>>('/candidates'),
      apiClient.getJson<Array<{ id: string; title: string }>>('/jobs'),
      apiClient.getJson<Array<{ id: string; name: string }>>('/departments'),
    ])
    const application = applicationRes.data.find((item) => item.id === detail.offer.applicationId)
    jobOptions.value = jobRes.data
    departmentOptions.value = departmentRes.data
    candidateName.value = candidateRes.data.find((item) => item.id === application?.candidateId)?.fullName || application?.candidateId || '未知候选人'
    jobTitle.value = jobRes.data.find((item) => item.id === application?.jobId)?.title || application?.jobId || '未知岗位'
    applicationCode.value = application?.code || ''
    departmentName.value = departmentRes.data.find((item) => item.id === detail.version?.departmentId)?.name || detail.version?.departmentId || ''
    await loadAuditEvents(id)
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取 Offer 详情失败').message
  } finally {
    loading.value = false
  }
}

function money(value?: { amount: number; currency: string }): string {
  if (!value) return '—'
  return `${value.currency} ${value.amount}`
}

function date(value?: string): string {
  return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
}

function run(action: OfferAction) {
  clearFlags()
  if (REASON_ACTIONS.includes(action)) {
    reason.value = ''
    pendingAction.value = action
    return
  }
  void execute(action)
}

async function submitPending() {
  if (!pendingAction.value) return
  const action = pendingAction.value
  const text = reason.value.trim()
  if (REASON_ACTIONS.includes(action) && !text) return
  pendingAction.value = null
  await execute(action, text || undefined)
}

async function execute(action: OfferAction, reasonText?: string) {
  if (!offer.value || acting.value) return
  acting.value = true
  clearFlags()
  try {
    const updated = await offerAction(offer.value.id, action, reasonText)
    const nextStatus = (updated && typeof updated === 'object' && 'status' in updated ? offerStatusCode(updated) : undefined) ?? offer.value.status
    offer.value.status = nextStatus
    feedback.value = `${OFFER_ACTION_LABEL[action]}成功，当前状态 ${OFFER_STATUS_LABEL[nextStatus] ?? nextStatus}`
    const detail = await getOffer(offer.value.id)
    offer.value = detail.offer
    currentVersion.value = detail.version ?? null
  } catch (cause) {
    error.value = describeApiFailure(cause, 'Offer 操作失败').message
  } finally {
    acting.value = false
  }
}

function openRevise() {
  if (!currentVersion.value) return
  clearFlags()
  const comp = currentVersion.value.compensation
  reviseForm.value = {
    jobId: jobOptions.value.find((item) => item.title === currentVersion.value?.positionTitle)?.id ?? '',
    positionTitle: currentVersion.value.positionTitle,
    departmentId: currentVersion.value.departmentId,
    employmentType: currentVersion.value.employmentType,
    startDate: currentVersion.value.startDate || '',
    baseSalaryAmount: comp.baseSalary?.amount ?? 0,
    currency: comp.baseSalary?.currency ?? 'CNY',
    bonusAmount: comp.bonus?.amount ?? 0,
    equity: comp.equity ?? '',
    benefitsText: (currentVersion.value.benefits || []).join('，'),
    content: currentVersion.value.content,
  }
  showRevise.value = true
}

function splitList(text: string): string[] {
  return text.split(/[，,、\n]/).map((s) => s.trim()).filter(Boolean)
}

/** 岗位只从已有岗位中选择；选中后带出岗位名称，并保持部门与岗位一致。 */
function applyJobSelection(jobId: string) {
  const job = jobOptions.value.find((item) => item.id === jobId)
  reviseForm.value.jobId = jobId
  if (!job) return
  reviseForm.value.positionTitle = job.title
  const department = departmentOptions.value.find((item) => item.id === job.departmentId || item.code === job.departmentId || item.name === job.department)
  if (department) reviseForm.value.departmentId = department.id
}

async function submitRevise() {
  if (!offer.value || revising.value) return
  const form = reviseForm.value
  if (!form.positionTitle.trim() || !form.departmentId.trim()) { error.value = '请填写职位名称与部门'; return }
  if (!(form.baseSalaryAmount > 0)) { error.value = '请填写有效薪资'; return }
  if (!form.content.trim()) { error.value = '请填写 Offer 内容'; return }
  revising.value = true
  clearFlags()
  try {
    const updated = await updateOffer(offer.value.id, {
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
    offer.value = updated
    const detail = await getOffer(updated.id)
    offer.value = detail.offer
    currentVersion.value = detail.version ?? null
    showRevise.value = false
    feedback.value = `Offer 已修订（版本 ${updated.version}）`
  } catch (cause) {
    error.value = describeApiFailure(cause, '修订 Offer 失败').message
  } finally {
    revising.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <PageHeader
      title="Offer 详情"
      subtitle="查看录用审批、版本、薪资本内容和状态轨迹"
      icon="⑥"
      crumb="录用 / Offer 详情"
    />

    <div v-if="loading" class="list-muted">正在加载 Offer 详情...</div>
    <div v-else-if="error" class="feedback error">{{ error }}</div>

    <section v-else-if="offer" class="detail-grid">
      <div class="card">
        <div class="section-title">Offer 基础信息</div>
        <dl class="info-list">
          <div><dt>状态</dt><dd><StatusTag :status="offer.status" /></dd></div>
          <div><dt>审批状态</dt><dd><StatusTag :status="offer.approval?.status || 'pending'" /></dd></div>
          <div><dt>审批人</dt><dd>{{ offer.approval?.approver || '待审批' }}</dd></div>
          <div><dt>候选人</dt><dd>{{ candidateName }}</dd></div>
          <div><dt>岗位</dt><dd>{{ jobTitle }}</dd></div>
          <div><dt>当前版本</dt><dd>V{{ offer.version }}</dd></div>
          <div><dt>发送时间</dt><dd>{{ date(offer.sentAt) }}</dd></div>
          <div><dt>回应时间</dt><dd>{{ date(offer.respondedAt) }}</dd></div>
          <div><dt>有效期至</dt><dd>{{ date(offer.expiresAt) }}</dd></div>
          <div><dt>更新时间</dt><dd>{{ date(offer.updatedAt) }}</dd></div>
        </dl>
      </div>

      <div class="card">
        <div class="section-title">状态操作</div>
        <div class="inline-actions" style="flex-wrap: wrap">
          <button v-if="offer.status === 'draft'" class="btn btn-ghost" type="button" @click="openRevise">修订</button>
          <button
            v-for="action in availableActions"
            :key="action"
            type="button"
            class="btn"
            :class="tone(action)"
            :disabled="acting"
            @click="run(action)"
          >
            {{ OFFER_ACTION_LABEL[action] }}
          </button>
          <span v-if="!availableActions.length && offer.status !== 'draft'" class="list-muted">{{ OFFER_STATUS_LABEL[offer.status] }}（终态）</span>
        </div>
        <div v-if="feedback" class="feedback success" style="margin-top:10px">{{ feedback }}</div>
      </div>

      <div class="card" v-if="currentVersion">
        <div class="section-title">当前版本内容</div>
        <dl class="info-list">
          <div><dt>职位名称</dt><dd>{{ currentVersion.positionTitle }}</dd></div>
          <div><dt>部门</dt><dd>{{ departmentName || currentVersion.departmentId }}</dd></div>
          <div><dt>用工类型</dt><dd>{{ employmentTypeLabel(currentVersion.employmentType) }}</dd></div>
          <div><dt>入职日期</dt><dd>{{ currentVersion.startDate || '—' }}</dd></div>
          <div><dt>基本薪资</dt><dd>{{ money(currentVersion.compensation.baseSalary) }}</dd></div>
          <div><dt>奖金</dt><dd>{{ money(currentVersion.compensation.bonus) }}</dd></div>
          <div><dt>股权</dt><dd>{{ currentVersion.compensation.equity || '—' }}</dd></div>
          <div><dt>福利</dt><dd>{{ (currentVersion.benefits || []).join('、') || '—' }}</dd></div>
        </dl>
        <div class="section-title" style="margin-top: 12px">Offer 内容</div>
        <p style="white-space: pre-wrap">{{ currentVersion.content }}</p>
      </div>

      <div class="card">
        <div class="section-title">版本历史</div>
        <div v-if="offer.versions?.length" class="table-wrap">
          <table>
            <thead><tr><th>版本</th><th>职位</th><th>基本薪资</th><th>创建时间</th></tr></thead>
            <tbody>
              <tr v-for="version in offer.versions" :key="version.id">
                <td>V{{ version.version }}</td>
                <td>{{ version.positionTitle }}</td>
                <td>{{ money(version.compensation.baseSalary) }}</td>
                <td>{{ date(version.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="list-muted">暂无历史版本</div>
      </div>

      <div class="card">
        <div class="section-title">流程审计</div>
        <WorkflowEventTable :events="auditEvents" :loading="loadingAudit" />
      </div>

      <div class="inline-actions">
        <button class="btn btn-ghost" type="button" @click="router.push('/offers')">返回 Offer 列表</button>
      </div>
    </section>

    <div v-if="pendingAction" class="overlay" role="presentation" @click.self="pendingAction = null">
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>{{ OFFER_ACTION_LABEL[pendingAction] }}</h3>
        <p>Offer {{ candidateName }} · {{ jobTitle }}</p>
        <div class="form-field">
          <label for="offer-detail-reason">操作原因（必填）</label>
          <textarea id="offer-detail-reason" v-model="reason" rows="3" placeholder="请填写操作原因"></textarea>
        </div>
        <div class="dialog-buttons">
          <button class="btn btn-ghost" type="button" @click="pendingAction = null">取消</button>
          <button class="btn btn-primary" type="button" :disabled="!reason.trim()" @click="submitPending">确认</button>
        </div>
      </div>
    </div>

    <div v-if="showRevise" class="overlay" role="presentation" @click.self="showRevise = false">
      <div class="dialog" role="dialog" aria-modal="true" style="max-width:620px">
        <h3>修订 Offer</h3>
        <div class="form-grid">
          <div class="form-field">
            <label>岗位</label>
            <select :value="reviseForm.jobId" @change="applyJobSelection(($event.target as HTMLSelectElement).value)">
              <option value="" disabled>选择岗位</option>
              <option v-for="job in jobOptions" :key="job.id" :value="job.id">{{ job.title }}{{ job.department ? `（${job.department}）` : '' }}</option>
            </select>
          </div>
          <div class="form-field">
            <label>部门</label>
            <select v-model="reviseForm.departmentId">
              <option value="" disabled>请选择部门</option>
              <option v-for="dept in departmentOptions" :key="dept.id" :value="dept.id">{{ dept.name }}</option>
            </select>
          </div>
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
  </div>
</template>
