<script setup lang="ts">
import { Send } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiClient } from '../../../shared/api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import ApplicationResumeButton from '../../candidates/components/ApplicationResumeButton.vue'
import RichTextEditor from '../components/RichTextEditor.vue'
import OfferMaterialsField from '../components/OfferMaterialsField.vue'
import OfferTemplateFields from '../components/OfferTemplateFields.vue'
import OfferSalaryFields from '../components/OfferSalaryFields.vue'
import { salaryFormError, salaryPayload } from '../utils/salary'
import { offerSalarySummary, offerSalaryTiming } from '@smartrecruit-pro/contracts'
import { additionalOfferVariables, offerTemplateFieldDefinitions, offerTemplateFieldValues, restoreOfferTemplateFields, type OfferTemplateFields as TemplateFields } from '../utils/templateFields'
import WorkflowEventTable from '../../../shared/components/workflow/WorkflowEventTable.vue'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { employmentTypeLabel } from '../../../shared/utils/labels'
import { loadWorkflowEvents, type WorkflowEvent } from '../../../shared/api/workflow-events'
import {
  getOffer,
  listOfferTemplates,
  type ApiOfferTemplate,
  offerAction,
  sendOfferEmail,
  previewOfferEmail,
  type SendOfferEmailInput,
  updateOffer,
  OFFER_ACTION_LABEL,
  OFFER_STATUS_LABEL,
  offerActionsFor,
  offerStatusCode,
  type ApiOffer,
  type ApiOfferVersion,
  type OfferEmailAttachment,
  type OfferAction,
  type OfferStatus,
} from '../api'
import { hasVisibleRichText, normalizeRichHtml, pinOfferEmailContent, renderOfferInvoiceFields, renderReportingLocation, renderHtmlTemplate } from '../utils/richText'
import { bindOfferContent, canonicalOfferVariable, offerContentValues, resolvedOfferContent, synchronizeOfferContent } from '../utils/offerContent'
const route = useRoute()
const router = useRouter()
const offer = ref<ApiOffer | null>(null)
const currentVersion = ref<ApiOfferVersion | null>(null)
const currentTemplateFields = computed(() => ({
  ...currentVersion.value?.templateFields,
  formalSalaryStartMonth: offerTemplateFieldValues(currentVersion.value?.templateFields).formalSalaryStartMonth,
}))
const candidateName = ref('')
const candidateEmail = ref('')
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
const showEmail = ref(false)
const emailSending = ref(false)
const attachmentReading = ref(false)
const emailError = ref('')
const attachmentInput = ref<HTMLInputElement | null>(null)
const attachmentName = ref('')
const emailForm = ref<{ to: string; subject: string; html: string; expiresAt: string; attachment?: OfferEmailAttachment }>({ to: '', subject: '', html: '', expiresAt: '' })
const templateVariables = [
  { value: '{{candidateName}}', label: '候选人姓名' },
  { value: '{{入职材料}}', label: '入职材料' },
  ...additionalOfferVariables,
  { value: '{{positionTitle}}', label: '岗位名称' },
  { value: '{{department}}', label: '所属部门' },
  { value: '{{startDate}}', label: '入职日期' },
  { value: '{{报到地点}}', label: '报到地点' },
  { value: '{{发票抬头}}', label: '发票抬头' },
  { value: '{{企业税号}}', label: '企业税号' },
  { value: '{{employmentType}}', label: '用工类型' },
  { value: '{{probationSalary}}', label: '初期月薪（兼容旧模板）' },
  { value: '{{formalSalary}}', label: '正常月薪' },
  { value: '{{benefits}}', label: '福利' },
]
const emailPreview = ref<{ to: string; subject: string; html: string; versionId: string } | null>(null)
const emailBody = ref<HTMLElement | null>(null)
watch(emailPreview, (preview) => {
  if (preview && emailBody.value) emailBody.value.scrollTop = 0
}, { flush: 'post' })
const previewFrame = ref<HTMLIFrameElement | null>(null)
const previewFrameHeight = ref(500)
let previewInput: SendOfferEmailInput | undefined
const historyVersion = ref<ApiOfferVersion | null>(null)
const bodyReviewed = ref(false)
const revisionTemplates = ref<ApiOfferTemplate[]>([])
const revisionTemplateId = ref('')
const revisionTemplatesLoading = ref(false)
const revisionTemplateError = ref('')
const showRevise = ref(false)
const reserveScrollbarGutter = ref(false)
watch(() => showEmail.value || showRevise.value, (isOpen) => {
  if (isOpen) reserveScrollbarGutter.value = window.innerWidth > document.documentElement.clientWidth
})
const revising = ref(false)
const reviseIntent = ref<'edit' | 'send'>('edit')
let revisionDraftKey = ''
let savedRevisionForm = ''
let emailDraftOfferId = ''
const jobOptions = ref<Array<{ id: string; title: string; departmentId?: string; department?: string }>>([])
const departmentOptions = ref<Array<{ id: string; code?: string; name: string }>>([])
const reviseForm = ref({
  jobId: '',
  positionTitle: '',
  departmentId: '',
  employmentType: 'full_time',
  startDate: '',
  reportingLocation: '',
  invoiceTitle: '',
  taxNumber: '',
  templateFields: {} as TemplateFields,
  probationSalaryAmount: 0,
  baseSalaryAmount: 0,
  currency: 'CNY',
  bonusAmount: 0,
  equity: '',
  benefitsText: '',
  materials: [] as string[],
  content: '',
})
const reviseValues = computed(() => {
  if (!currentVersion.value) return {}
  const form = reviseForm.value
  return offerContentValues({ ...currentVersion.value,
    positionTitle: form.positionTitle, departmentId: form.departmentId, employmentType: form.employmentType,
    startDate: reportingDate(form.templateFields, form.startDate), reportingLocation: form.reportingLocation,
    invoiceTitle: form.invoiceTitle, taxNumber: form.taxNumber, templateFields: form.templateFields,
    compensation: { baseSalary: { amount: form.baseSalaryAmount, currency: 'CNY' }, probationSalary: form.employmentType === 'full_time' && offerSalaryTiming(form.templateFields).probationSalaryMonths !== '0' ? { amount: form.probationSalaryAmount, currency: 'CNY' } : undefined, bonus: form.bonusAmount > 0 ? { amount: form.bonusAmount, currency: 'CNY' } : undefined, equity: form.equity },
    benefits: splitList(form.benefitsText), materials: form.materials,
  }, candidateName.value, departmentOptions.value.find(item => item.id === form.departmentId)?.name ?? departmentName.value)
})
const legacyWarnings = computed(() => {
  if (!showRevise.value || !currentVersion.value) return []
  const original = offerContentValues(currentVersion.value, candidateName.value, departmentName.value)
  const doc = new DOMParser().parseFromString(reviseForm.value.content, 'text/html')
  const bound = new Set([...doc.querySelectorAll<HTMLElement>('[data-offer-variable]')].map(span => span.dataset.offerVariable))
  doc.querySelectorAll('[data-offer-variable]').forEach(span => span.remove())
  return Object.entries(original).filter(([key, value]) => canonicalOfferVariable(key) === key && value.length >= 2 && reviseValues.value[key] !== value && !bound.has(key) && doc.body.textContent?.includes(value)).map(([key]) => templateVariables.find(item => canonicalOfferVariable(item.value.slice(2, -2)) === key)?.label ?? key)
})
const salaryBodyReviewRequired = computed(() => {
  if (!showRevise.value || !currentVersion.value) return false
  const original = offerContentValues(currentVersion.value)
  const changed = ['probationDuration', 'probationSalaryMonths', 'formalSalaryStartMonth', 'baseSalary', 'probationSalary'].some(key => original[key] !== reviseValues.value[key])
  return changed && !reviseForm.value.content.includes('data-offer-variable="salaryArrangement"')
})
watch(reviseValues, values => {
  if (!showRevise.value) return
  bodyReviewed.value = false
  reviseForm.value.content = synchronizeOfferContent(reviseForm.value.content, values)
})
watch(emailForm, () => { emailPreview.value = null; previewInput = undefined }, { deep: true, flush: 'sync' })
const displayedContent = computed(() => currentVersion.value ? resolvedOfferContent(currentVersion.value.content, offerContentValues(currentVersion.value, candidateName.value, departmentName.value)) : '')

const REASON_ACTIONS: OfferAction[] = ['decline', 'cancel', 'confirm-revision']

function reportingDate(fields: TemplateFields, fallback = ''): string {
  const value = fields.reportingTime ?? ''
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(value)) return value.slice(0, 10)
  return fallback
}

const availableActions = computed<OfferAction[]>(() => {
  if (!offer.value) return []
  return offerActionsFor(offer.value.status, offer.value.onboarding?.status)
})
const nonResendActions = computed(() => availableActions.value.filter((action) => action !== 'resend'))
const canEditOffer = computed(() => ['draft', 'sent', 'cancelled', 'accepted'].includes(offer.value?.status ?? '') && (offer.value?.status === 'accepted' || !offer.value?.onboarding))
const isResending = computed(() => ['sent', 'cancelled', 'accepted'].includes(offer.value?.status ?? ''))

function tone(action: OfferAction): string {
  if (action === 'decline' || action === 'cancel') return 'btn-danger'
  if (action === 'send' || action === 'resend') return 'btn-primary'
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
      apiClient.getJson<Array<{ id: string; fullName: string; email?: string; code?: string }>>('/candidates'),
      apiClient.getJson<Array<{ id: string; title: string }>>('/jobs'),
      apiClient.getJson<Array<{ id: string; name: string }>>('/departments'),
    ])
    const application = applicationRes.data.find((item) => item.id === detail.offer.applicationId)
    jobOptions.value = jobRes.data
    departmentOptions.value = departmentRes.data
    const candidate = candidateRes.data.find((item) => item.id === application?.candidateId)
    candidateName.value = candidate?.fullName || application?.candidateId || '未知候选人'
    candidateEmail.value = candidate?.email || ''
    jobTitle.value = detail.version?.positionTitle || jobRes.data.find((item) => item.id === application?.jobId)?.title || application?.jobId || '未知岗位'
    applicationCode.value = application?.code || ''
    departmentName.value = departmentRes.data.find((item) => item.id === detail.version?.departmentId)?.name || detail.version?.departmentId || ''
    await loadAuditEvents(id)
    if (route.query.compose === 'email') openEmail()
    else if (route.query.edit === '1' && canEditOffer.value) openRevise()
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取 Offer 详情失败').message
  } finally {
    loading.value = false
  }
}

function money(value?: { amount: number; currency: string }): string {
  if (!value) return '—'
  return `¥${value.amount.toLocaleString('zh-CN')}`
}

function salaryLabel(employmentType: string): string {
  return employmentType === 'full_time' ? '正常月薪' : '实习工资'
}

function date(value?: string): string {
  return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
}

function run(action: OfferAction) {
  clearFlags()
  if (action === 'send' || action === 'resend') {
    openEmail()
    return
  }
  if (REASON_ACTIONS.includes(action)) {
    reason.value = ''
    pendingAction.value = action
    return
  }
  void execute(action)
}

function defaultEmailTemplate(): string {
  const fullTime = currentVersion.value?.employmentType === 'full_time'
  const compensation = fullTime
    ? '<li>薪资安排：{{薪资安排说明}}</li>'
    : '<li>实习工资：{{formalSalary}} 元/月</li>'
  return `<p>{{candidateName}}，您好：</p><h1>Offer 录用通知</h1><p>很高兴通知您，您已通过本次招聘流程，现诚邀您加入我们。</p><ul><li>职位：{{positionTitle}}</li><li>用工类型：{{employmentType}}</li><li>预计入职日期：{{startDate}}</li>${compensation}</ul><p>请查收附件中的 Offer 文件，并回复本邮件确认。</p><p>祝好！</p>`
}

function currentOfferEmailHtml(): string {
  if (!currentVersion.value) return ''
  const version = currentVersion.value
  const content = renderOfferInvoiceFields(renderReportingLocation(version.content.trim(), version.reportingLocation ?? ''), version)
  const template = pinOfferEmailContent(normalizeRichHtml(content) || defaultEmailTemplate(), candidateName.value, version.materials)
  return resolvedOfferContent(template, offerContentValues(version, candidateName.value, departmentName.value))
}

function openEmail() {
  if (!offer.value || !currentVersion.value) return
  initializeEmailForm()
  if (isResending.value && canEditOffer.value) {
    openRevise('send')
    return
  }
  showEmail.value = true
}

function initializeEmailForm() {
  if (!offer.value || !currentVersion.value) return
  emailError.value = ''
  const existing = emailDraftOfferId === offer.value.id ? emailForm.value : null
  emailForm.value = {
    to: existing?.to ?? offer.value.lastEmail?.to ?? candidateEmail.value,
    expiresAt: existing?.expiresAt ?? (offer.value.status !== 'accepted' && offer.value.expiresAt ? new Date(Date.parse(offer.value.expiresAt) + 8 * 3600000).toISOString().slice(0, 16) : ''),
    subject: existing?.subject ?? offer.value.lastEmail?.subject ?? `Offer 录用通知｜${currentVersion.value.positionTitle}`,
    html: currentOfferEmailHtml(),
    ...(existing?.attachment ? { attachment: existing.attachment } : {}),
  }
  emailDraftOfferId = offer.value.id
}

function resetEmailForm() {
  showEmail.value = false
  emailError.value = ''
  attachmentName.value = ''
  delete emailForm.value.attachment
  emailPreview.value = null
  previewInput = undefined
  if (attachmentInput.value) attachmentInput.value.value = ''
}

function closeEmail() {
  if (emailSending.value || attachmentReading.value) return
  showEmail.value = false
  emailError.value = ''
  emailPreview.value = null
  previewInput = undefined
}

async function selectAttachment(event: Event) {
  if (isResending.value || emailSending.value || attachmentReading.value) return
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  emailError.value = ''
  if (!file) return
  if (file.size > 10 * 1024 * 1024) {
    emailError.value = 'PDF 附件不能超过 10 MiB'
    input.value = ''
    return
  }
  if (file.type && file.type !== 'application/pdf') {
    emailError.value = '只能上传 PDF 附件'
    input.value = ''
    return
  }
  try {
    attachmentReading.value = true
    emailForm.value.attachment = undefined
    attachmentName.value = ''
    const content = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result !== 'string' || !reader.result.includes(',')) {
          reject(new Error('无法读取 PDF 附件'))
          return
        }
        resolve(reader.result.slice(reader.result.indexOf(',') + 1))
      }
      reader.onerror = () => reject(new Error('无法读取 PDF 附件'))
      reader.readAsDataURL(file)
    })
    emailForm.value.attachment = { filename: file.name, mimeType: 'application/pdf', content }
    attachmentName.value = file.name
  } catch (cause) {
    emailError.value = cause instanceof Error ? cause.message : '无法读取 PDF 附件'
    input.value = ''
  } finally {
    attachmentReading.value = false
  }
}

function removeAttachment() {
  if (emailSending.value || attachmentReading.value) return
  emailForm.value.attachment = undefined
  attachmentName.value = ''
  if (attachmentInput.value) attachmentInput.value.value = ''
}

async function sendEmail() {
  if (!offer.value || emailSending.value || attachmentReading.value) return
  const to = emailForm.value.to.trim()
  const subject = emailForm.value.subject.trim()
  const html = (emailPreview.value?.html ?? currentOfferEmailHtml()).trim()
  if (!to) { emailError.value = '请填写收件人邮箱'; return }
  if (!subject) { emailError.value = '请填写邮件主题'; return }
  if (!hasVisibleRichText(html)) { emailError.value = '请填写邮件正文'; return }
  const expiry = emailForm.value.expiresAt ? new Date(emailForm.value.expiresAt + ':00+08:00') : undefined
  if (expiry && (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now())) { emailError.value = '有效期必须晚于当前时间'; return }
  emailSending.value = true
  emailError.value = ''
  try {
    if (!emailPreview.value) {
      emailForm.value.html = html
      const input = { to, subject, html, versionId: currentVersion.value?.id, ...(expiry ? { expiresAt: expiry.toISOString() } : {}), ...(!isResending.value && emailForm.value.attachment ? { attachment: emailForm.value.attachment } : {}) }
      emailPreview.value = await previewOfferEmail(offer.value.id, input)
      previewInput = { ...input, versionId: emailPreview.value.versionId }
      return
    }
    if (!previewInput) return
    const updated = await sendOfferEmail(offer.value.id, previewInput)
    offer.value = updated
    resetEmailForm()
    feedback.value = `Offer 邮件已发送至 ${to}`
    try {
      const detail = await getOffer(updated.id)
      offer.value = detail.offer
      currentVersion.value = detail.version ?? null
      await loadAuditEvents(updated.id)
    } catch {
      feedback.value += '；详情刷新失败，请稍后刷新页面，无需重复发送。'
    }
  } catch (cause) {
    emailError.value = describeApiFailure(cause, 'Offer 邮件发送失败').message
  } finally {
    emailSending.value = false
  }
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
    const updated = await offerAction(offer.value.id, action, reasonText, currentVersion.value?.id)
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

async function loadRevisionTemplates() {
  revisionTemplatesLoading.value = true
  revisionTemplateError.value = ''
  try {
    revisionTemplates.value = (await listOfferTemplates()).filter(template => template.isActive)
    if (!revisionTemplates.value.some(template => template.id === revisionTemplateId.value)) {
      revisionTemplateId.value = revisionTemplates.value.find(template => template.isDefault)?.id
        ?? (revisionTemplates.value.length === 1 ? revisionTemplates.value[0]!.id : '')
    }
  } catch (cause) {
    revisionTemplateError.value = describeApiFailure(cause, '读取 Offer 模板失败').message
  } finally {
    revisionTemplatesLoading.value = false
  }
}

async function reapplyRevisionTemplate() {
  if (revisionTemplatesLoading.value || !revisionTemplateId.value) return
  const selectedId = revisionTemplateId.value
  await loadRevisionTemplates()
  if (revisionTemplateError.value) return
  const template = revisionTemplates.value.find(item => item.id === selectedId)
  if (!template) { revisionTemplateError.value = '所选模板已停用或删除，请重新选择'; return }
  if (!window.confirm('重新套用将替换当前正文，保留已填写的薪资、税号等字段。是否继续？')) return
  reviseForm.value.content = synchronizeOfferContent(bindOfferContent(template.content, reviseValues.value, true), reviseValues.value)
  bodyReviewed.value = false
  emailPreview.value = null
  previewInput = undefined
}

function openRevise(intent: 'edit' | 'send' = 'edit') {
  if (!currentVersion.value) return
  void loadRevisionTemplates()
  clearFlags()
  reviseIntent.value = intent
  const draftKey = `${offer.value?.id}:${currentVersion.value?.id}`
  if (revisionDraftKey === draftKey) {
    showRevise.value = true
    return
  }
  const comp = currentVersion.value.compensation
  reviseForm.value = {
    jobId: jobOptions.value.find((item) => item.title === currentVersion.value?.positionTitle)?.id ?? '',
    positionTitle: currentVersion.value.positionTitle,
    departmentId: currentVersion.value.departmentId,
    employmentType: currentVersion.value.employmentType,
    startDate: currentVersion.value.startDate || '',
    reportingLocation: currentVersion.value.reportingLocation || '',
    invoiceTitle: currentVersion.value.invoiceTitle || '',
    taxNumber: currentVersion.value.taxNumber || '',
    templateFields: restoreOfferTemplateFields(currentVersion.value.templateFields, currentVersion.value.startDate),
    probationSalaryAmount: comp.probationSalary?.amount ?? 0,
    baseSalaryAmount: comp.baseSalary?.amount ?? 0,
    currency: comp.baseSalary?.currency ?? 'CNY',
    bonusAmount: comp.bonus?.amount ?? 0,
    equity: comp.equity ?? '',
    benefitsText: (currentVersion.value.benefits || []).join('，'),
    materials: [...(currentVersion.value.materials || [])],
    content: bindOfferContent(currentVersion.value.content, offerContentValues(currentVersion.value, candidateName.value, departmentName.value), true),
  }
  reviseForm.value.content = synchronizeOfferContent(reviseForm.value.content, reviseValues.value)
  revisionDraftKey = draftKey
  savedRevisionForm = JSON.stringify(reviseForm.value)
  bodyReviewed.value = false
  showRevise.value = true
}

async function previewRevisionEmail() {
  if (revising.value || emailSending.value) return
  if (!emailForm.value.to.trim()) { error.value = '请填写收件人邮箱'; return }
  if (!emailForm.value.subject.trim()) { error.value = '请填写邮件主题'; return }
  if (JSON.stringify(reviseForm.value) !== savedRevisionForm && !await submitRevise()) return
  initializeEmailForm()
  showRevise.value = false
  showEmail.value = true
  await sendEmail()
}

function fitEmailPreview() {
  const frame = previewFrame.value
  const document = frame?.contentDocument
  if (!frame || !document) return
  previewFrameHeight.value = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, 320)
}

function returnToEmailEditor() {
  emailPreview.value = null
  previewInput = undefined
  if (isResending.value && canEditOffer.value) {
    showEmail.value = false
    openRevise('send')
  }
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

async function submitRevise(): Promise<boolean> {
  if (!offer.value || revising.value) return false
  const form = reviseForm.value
  if (!form.positionTitle.trim() || !form.departmentId.trim()) { error.value = '请填写职位名称与部门'; return false }
  const original = currentVersion.value
  const salaryUnchanged = original && original.employmentType === form.employmentType
    && original.compensation.baseSalary.amount === form.baseSalaryAmount && (original.compensation.probationSalary?.amount ?? 0) === form.probationSalaryAmount
    && ['probationDuration', 'probationSalaryMonths', 'formalSalaryStartMonth'].every(key => (original.templateFields?.[key as keyof TemplateFields] ?? '') === (form.templateFields[key as keyof TemplateFields] ?? ''))
  const salaryError = salaryUnchanged ? '' : salaryFormError(form.employmentType, form.templateFields, form.baseSalaryAmount, form.probationSalaryAmount)
  if (salaryError) { error.value = salaryError; return false }
  if (legacyWarnings.value.length && !bodyReviewed.value) { error.value = '请核对正文中未绑定引用的旧信息'; return false }
  if (salaryBodyReviewRequired.value && !bodyReviewed.value) { error.value = '请核对正文中的薪资安排后再保存'; return false }
  if (!form.content.trim()) { error.value = '请填写 Offer 内容'; return false }
  if (form.materials.some((item) => item === 'other' || (item.startsWith('other:') && !item.slice(6).trim()))) { error.value = '请填写其他入职材料的名称'; return false }
  revising.value = true
  clearFlags()
  try {
    const updated = await updateOffer(offer.value.id, {
      positionTitle: form.positionTitle.trim(),
      departmentId: form.departmentId.trim(),
      employmentType: form.employmentType,
      startDate: reportingDate(form.templateFields, form.startDate),
      reportingLocation: form.reportingLocation.trim(),
      invoiceTitle: form.invoiceTitle.trim(),
      taxNumber: form.taxNumber.trim(),
      ...(salaryUnchanged ? { templateFields: form.templateFields } : salaryPayload(form.employmentType, form.templateFields, form.probationSalaryAmount)),
      baseSalary: { amount: form.baseSalaryAmount, currency: 'CNY' },
      bonus: form.bonusAmount > 0 ? { amount: form.bonusAmount, currency: 'CNY' } : undefined,
      equity: form.equity.trim() || undefined,
      benefits: splitList(form.benefitsText),
      materials: form.materials.map((item) => item.trim()),
      content: synchronizeOfferContent(form.content.trim(), reviseValues.value),
    }, offer.value.version)
    offer.value = updated
    try {
      const detail = await getOffer(updated.id)
      const expectedVersionId = updated.currentVersionId
      if (!expectedVersionId || detail.offer.currentVersionId !== expectedVersionId || detail.version?.id !== expectedVersionId) {
        currentVersion.value = null
        error.value = '新版本已保存，但当前版本尚未刷新成功，请刷新页面后再预览或发送。'
        return false
      }
      offer.value = detail.offer
      currentVersion.value = detail.version ?? null
      jobTitle.value = detail.version?.positionTitle ?? jobTitle.value
      departmentName.value = departmentOptions.value.find(item => item.id === detail.version?.departmentId)?.name ?? detail.version?.departmentId ?? ''
      revisionDraftKey = `${offer.value?.id}:${currentVersion.value?.id}`
      savedRevisionForm = JSON.stringify(reviseForm.value)
      showRevise.value = false
      feedback.value = 'Offer 已保存为新版本，旧版本已保留'
      await loadAuditEvents(updated.id)
    } catch {
      currentVersion.value = null
      error.value = '新版本已保存，但详情刷新失败，请刷新页面后再继续操作，不要重复保存。'
      return false
    }
    return true
  } catch (cause) {
    error.value = describeApiFailure(cause, '修订 Offer 失败').message
    return false
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
      subtitle="查看 Offer 版本、薪资本内容和状态轨迹"
      icon="⑥"
      crumb="录用 / Offer 详情"
    >
      <button class="btn btn-ghost" type="button" @click="router.push('/offers')">返回 Offer 列表</button>
    </PageHeader>

    <div v-if="loading" class="list-muted">正在加载 Offer 详情...</div>
    <div v-if="error && !showRevise" class="feedback error">{{ error }}</div>

    <section v-if="!loading && offer" class="offer-detail-layout">
      <div class="card offer-summary-card">
        <div class="section-title">Offer 基础信息</div>
        <dl class="info-list">
          <div><dt>状态</dt><dd><StatusTag :status="offer.status" /></dd></div>
          <div><dt>候选人</dt><dd>{{ candidateName }}</dd></div>
          <div><dt>岗位</dt><dd>{{ jobTitle }}</dd></div>
          <div><dt>当前版本</dt><dd>{{ currentVersion ? 'V' + currentVersion.version : '—' }}</dd></div>
          <div v-if="offer.status === 'accepted'"><dt>版本确认</dt><dd :class="offer.confirmation?.currentVersionStatus === 'pending' ? 'confirmation-pending' : ''">{{ offer.confirmation?.currentVersionStatus === 'confirmed' ? '当前版本已确认' : '新版本待确认' }}</dd></div>
          <div v-if="offer.confirmation?.lastSentAt"><dt>最近发送</dt><dd>{{ date(offer.confirmation.lastSentAt) }}</dd></div>
          <div><dt>发送时间</dt><dd>{{ date(offer.sentAt) }}</dd></div>
          <div><dt>回应时间</dt><dd>{{ date(offer.respondedAt) }}</dd></div>
          <div><dt>有效期至</dt><dd>{{ date(offer.expiresAt) }}</dd></div>
          <div><dt>更新时间</dt><dd>{{ date(offer.updatedAt) }}</dd></div>
        </dl>
      </div>

      <div class="card offer-actions-card">
        <div class="section-title">状态操作</div>
        <div class="inline-actions" style="flex-wrap: wrap">
          <ApplicationResumeButton :application-id="offer.applicationId" />
          <button v-if="offer.status === 'accepted' && offer.confirmation?.currentVersionStatus === 'pending'" class="btn btn-ghost" type="button" :disabled="acting || emailSending" @click="run('confirm-revision')">记录新版本确认</button>
          <button
            v-if="offer.status === 'cancelled'"
            class="btn btn-ghost"
            type="button"
            @click="router.push({ path: '/offers', query: { recreateOfferId: offer.id } })"
          >重新创建</button>
          <button
            v-for="action in nonResendActions"
            :key="action"
            type="button"
            class="btn"
            :class="tone(action)"
            :disabled="acting || emailSending"
            @click="run(action)"
          >
            {{ OFFER_ACTION_LABEL[action] }}
          </button>
          <span v-if="!availableActions.length && offer.status !== 'draft'" class="list-muted">{{ OFFER_STATUS_LABEL[offer.status] }}（终态）</span>
        </div>
        <div v-if="feedback" class="feedback success" style="margin-top:10px">{{ feedback }}</div>
      </div>

      <div class="card offer-content-card" v-if="currentVersion">
        <div class="content-section-heading">
          <div class="section-title">当前版本内容</div>
          <button v-if="canEditOffer" class="btn btn-ghost" type="button" @click="openRevise()">编辑</button>
        </div>
        <dl class="info-list">
          <div><dt>职位名称</dt><dd>{{ currentVersion.positionTitle }}</dd></div>
          <div><dt>部门</dt><dd>{{ departmentName || currentVersion.departmentId }}</dd></div>
          <div><dt>用工类型</dt><dd>{{ employmentTypeLabel(currentVersion.employmentType) }}</dd></div>
          <div><dt>入职日期</dt><dd>{{ currentVersion.startDate || '—' }}</dd></div>
          <div><dt>报到地点</dt><dd>{{ currentVersion.reportingLocation || '—' }}</dd></div>
          <div><dt>发票抬头</dt><dd>{{ currentVersion.invoiceTitle || '—' }}</dd></div>
          <div><dt>企业税号</dt><dd>{{ currentVersion.taxNumber || '—' }}</dd></div>
          <template v-for="field in offerTemplateFieldDefinitions" :key="field.key">
            <div v-if="currentTemplateFields[field.key]"><dt>{{ field.label }}</dt><dd>{{ field.key === 'reportingTime' ? currentTemplateFields[field.key]?.replace('T', ' ') : currentTemplateFields[field.key] }}</dd></div>
          </template>
          <div v-if="currentVersion.employmentType === 'full_time' && offerSalaryTiming(currentVersion.templateFields).probationSalaryMonths !== '0'"><dt>初期月薪</dt><dd>{{ money(currentVersion.compensation.probationSalary) }}</dd></div>
          <div v-if="currentVersion.employmentType === 'full_time'" style="grid-column:1 / -1"><dt>薪资安排</dt><dd>{{ offerSalarySummary(currentVersion.templateFields ?? {}, currentVersion.compensation.baseSalary.amount, currentVersion.compensation.probationSalary?.amount) }}</dd></div>
          <div><dt>{{ salaryLabel(currentVersion.employmentType) }}</dt><dd>{{ money(currentVersion.compensation.baseSalary) }}</dd></div>
          <div><dt>奖金</dt><dd>{{ money(currentVersion.compensation.bonus) }}</dd></div>
          <div><dt>股权</dt><dd>{{ currentVersion.compensation.equity || '—' }}</dd></div>
          <div><dt>福利</dt><dd>{{ (currentVersion.benefits || []).join('、') || '—' }}</dd></div>
        </dl>
        <div class="section-title" style="margin-top: 12px">Offer 内容</div>
        <RichTextEditor :model-value="displayedContent" :editable="false" :show-toolbar="false" :min-height="0" />
      </div>

      <div class="card offer-history-card">
        <div class="section-title">版本历史</div>
        <div v-if="offer.versions?.length" class="table-wrap">
          <table>
            <thead><tr><th>版本</th><th>职位</th><th>薪资</th><th>创建时间</th><th>候选人确认</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="version in offer.versions" :key="version.id">
                <td>V{{ version.version }}</td>
                <td>{{ version.positionTitle }}</td>
                <td>{{ version.employmentType === 'full_time' ? `试用 ${money(version.compensation.probationSalary)} / 转正 ${money(version.compensation.baseSalary)}` : `实习 ${money(version.compensation.baseSalary)}` }}</td>
                <td>{{ date(version.createdAt) }}</td>
                <td><template v-if="offer.confirmation?.confirmations.some(item => item.versionId === version.id)"><div v-for="record in offer.confirmation.confirmations.filter(item => item.versionId === version.id)" :key="record.acceptedAt">已确认 · {{ date(record.acceptedAt) }}<div v-if="record.reason">{{ record.reason }}</div></div></template><span v-else>未确认</span></td>
                <td><button class="btn btn-ghost" type="button" @click="historyVersion = version">查看</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="list-muted">暂无历史版本</div>
      </div>

      <div class="card offer-audit-card">
        <div class="section-title">流程审计</div>
        <WorkflowEventTable :events="auditEvents" :loading="loadingAudit" />
      </div>

      <div class="offer-detail-footer">
        <button class="btn btn-ghost" type="button" @click="router.push('/offers')">返回 Offer 列表</button>
      </div>

      <button
        v-if="availableActions.includes('resend')"
        class="btn btn-primary floating-resend-button"
        type="button"
        :disabled="acting || emailSending"
        @click="run('resend')"
      >{{ emailSending ? '发送中...' : '重新发送' }}</button>
    </section>

    <div v-if="pendingAction" class="overlay" role="presentation" @click.self="pendingAction = null">
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>{{ OFFER_ACTION_LABEL[pendingAction] }}</h3>
        <p>Offer {{ candidateName }} · {{ jobTitle }}</p>
        <div class="form-field">
          <label for="offer-detail-reason">{{ pendingAction === 'confirm-revision' ? '候选人确认依据（必填）' : '操作原因（必填）' }}</label>
          <textarea id="offer-detail-reason" v-model="reason" rows="3" placeholder="请填写操作原因"></textarea>
        </div>
        <div class="dialog-buttons">
          <button class="btn btn-ghost" type="button" @click="pendingAction = null">取消</button>
          <button class="btn btn-primary" type="button" :disabled="!reason.trim()" @click="submitPending">确认</button>
        </div>
      </div>
    </div>

    <div v-if="showEmail" class="overlay offer-scroll-lock" :class="{ 'offer-scroll-gutter': reserveScrollbarGutter }" role="presentation">
      <div class="dialog offer-email-dialog" role="dialog" aria-modal="true" aria-labelledby="offer-email-title">
        <header class="offer-email-header">
          <div class="offer-email-title-row">
            <h3 id="offer-email-title">{{ isResending ? '重新发送 Offer 邮件' : '发送 Offer 邮件' }}</h3>
            <button v-if="emailPreview" class="btn btn-primary" type="button" :disabled="emailSending || attachmentReading" @click="sendEmail"><Send :size="14" aria-hidden="true" />{{ emailSending ? '处理中...' : '确认发送' }}</button>
          </div>
          <p v-if="emailError" class="feedback error" role="alert">{{ emailError }}</p>
        </header>
        <div ref="emailBody" class="offer-email-body">
          <div v-if="!emailPreview" class="form-grid">
            <div class="form-field" style="grid-column:1 / -1"><label for="offer-email-to">收件人</label><input id="offer-email-to" v-model="emailForm.to" type="email" autocomplete="email" placeholder="candidate@example.com" :disabled="emailSending || attachmentReading" /></div>
            <div class="form-field" style="grid-column:1 / -1"><label for="offer-email-subject">邮件主题</label><input id="offer-email-subject" v-model="emailForm.subject" maxlength="200" :disabled="emailSending || attachmentReading" /></div>
            <div v-if="offer?.status !== 'accepted'" class="form-field" style="grid-column:1 / -1"><label for="offer-email-expiry">有效期至（北京时间，可选）</label><input id="offer-email-expiry" v-model="emailForm.expiresAt" type="datetime-local" :disabled="emailSending || attachmentReading" /></div>
            <div class="form-field" style="grid-column:1 / -1">
              <div class="content-section-heading"><label>邮件正文</label><button v-if="canEditOffer" class="btn btn-ghost" type="button" :disabled="emailSending || attachmentReading" @click="closeEmail(); openRevise(isResending ? 'send' : 'edit')">编辑</button></div>
              <RichTextEditor id="offer-email-editor" :model-value="emailForm.html" :editable="false" :show-toolbar="false" :min-height="360" />
            </div>
            <div v-if="!isResending" class="form-field" style="grid-column:1 / -1">
              <label for="offer-email-attachment">PDF 附件</label>
              <input id="offer-email-attachment" ref="attachmentInput" type="file" accept="application/pdf,.pdf" :disabled="emailSending || attachmentReading" @change="selectAttachment" />
              <p v-if="attachmentReading" class="muted">正在读取 PDF 附件...</p>
              <div v-if="attachmentName" class="attachment-row"><span>{{ attachmentName }}</span><button class="btn btn-ghost" type="button" :disabled="emailSending || attachmentReading" @click="removeAttachment">移除</button></div>
            </div>
          </div>
          <section v-else class="email-final-preview">
            <h4>最终邮件预览 · V{{ currentVersion?.version }}</h4>
            <p>收件人：{{ emailPreview.to }}</p><p>主题：{{ emailPreview.subject }}</p>
            <p v-if="attachmentName">附件：{{ attachmentName }}</p>
            <iframe ref="previewFrame" title="最终邮件正文" sandbox="allow-same-origin" :style="{ height: `${previewFrameHeight}px` }" :srcdoc="emailPreview.html" @load="fitEmailPreview" />
          </section>
          <div class="dialog-buttons">
            <button class="btn btn-ghost" type="button" :disabled="emailSending || attachmentReading" @click="closeEmail">取消</button>
            <button v-if="emailPreview" class="btn btn-ghost" type="button" :disabled="emailSending" @click="returnToEmailEditor">返回</button>
            <button v-else class="btn btn-primary" type="button" :disabled="emailSending || attachmentReading" @click="sendEmail">{{ emailSending ? '处理中...' : attachmentReading ? '读取附件中...' : '预览邮件' }}</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="historyVersion" class="overlay" role="presentation">
      <div class="dialog offer-email-dialog" role="dialog" aria-modal="true" aria-label="历史版本">
        <h3>历史版本 V{{ historyVersion.version }}</h3>
        <RichTextEditor :model-value="historyVersion.content" :editable="false" :show-toolbar="false" :min-height="0" />
        <div class="dialog-buttons"><button class="btn btn-ghost" type="button" @click="historyVersion = null">关闭</button></div>
      </div>
    </div>

    <div v-if="showRevise" class="overlay offer-scroll-lock" :class="{ 'offer-scroll-gutter': reserveScrollbarGutter }" role="presentation">
    <div class="dialog offer-revise-dialog" role="dialog" aria-modal="true" aria-labelledby="offer-revise-title">
      <header class="offer-revise-header"><h3 id="offer-revise-title">{{ reviseIntent === 'send' ? '重新发送 Offer 邮件' : '修订 Offer' }}</h3></header>
      <div class="offer-revise-body">
        <div v-if="legacyWarnings.length" class="feedback error" role="alert">正文中的{{ legacyWarnings.join('、') }}未绑定引用，请核对后再保存。<label><input v-model="bodyReviewed" type="checkbox" />已核对正文与本次修改一致</label></div>
        <label v-if="salaryBodyReviewRequired && !legacyWarnings.length" class="salary-body-review"><input v-model="bodyReviewed" type="checkbox" />已核对正文中的薪资安排与本次填写一致</label>
        <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
        <div class="form-grid">
          <template v-if="reviseIntent === 'send'">
            <div class="form-field" style="grid-column:1 / -1"><label for="offer-email-to">收件人</label><input id="offer-email-to" v-model="emailForm.to" type="email" autocomplete="email" /></div>
            <div class="form-field" style="grid-column:1 / -1"><label for="offer-email-subject">邮件主题</label><input id="offer-email-subject" v-model="emailForm.subject" maxlength="200" /></div>
            <div v-if="offer?.status !== 'accepted'" class="form-field" style="grid-column:1 / -1"><label for="offer-email-expiry">有效期至（北京时间，可选）</label><input id="offer-email-expiry" v-model="emailForm.expiresAt" type="datetime-local" /></div>
          </template>
          <h4 class="offer-form-heading">录用信息</h4>
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
            <select v-model="reviseForm.employmentType"><option value="full_time">全职</option><option value="internship">实习</option></select>
          </div>
          <h4 class="offer-form-heading">报到安排</h4>
          <OfferTemplateFields v-model="reviseForm.templateFields" :employment-type="reviseForm.employmentType" />
          <div class="form-field"><label>报到地点</label><input v-model="reviseForm.reportingLocation" maxlength="300" placeholder="请输入候选人报到地点" /></div>
      <div class="form-field"><label>发票抬头</label><input v-model="reviseForm.invoiceTitle" maxlength="200" placeholder="请输入发票抬头" /></div>
      <div class="form-field"><label>企业税号</label><input v-model="reviseForm.taxNumber" maxlength="100" placeholder="请输入企业税号" /></div>
          <OfferSalaryFields v-model:fields="reviseForm.templateFields" v-model:base-salary="reviseForm.baseSalaryAmount" v-model:initial-salary="reviseForm.probationSalaryAmount" :employment-type="reviseForm.employmentType" />
          <h4 class="offer-form-heading">福利与材料</h4>
          <div class="form-field"><label>奖金（元，可选）</label><input v-model.number="reviseForm.bonusAmount" type="number" min="0" /></div>
          <div class="form-field"><label>股权（可选）</label><input v-model="reviseForm.equity" /></div>
          <div class="form-field" style="grid-column:1 / -1"><label>福利（逗号分隔）</label><input v-model="reviseForm.benefitsText" /></div>
          <OfferMaterialsField v-model="reviseForm.materials" style="grid-column: 1 / -1" />
          <div class="form-field" style="grid-column:1 / -1">
            <label for="revision-template">Offer 模板</label>
            <div class="revision-template-controls">
              <select id="revision-template" v-model="revisionTemplateId" :disabled="revisionTemplatesLoading || revising || emailSending">
                <option value="">保留当前正文</option>
                <option v-for="template in revisionTemplates" :key="template.id" :value="template.id">{{ template.name }}</option>
              </select>
              <button class="btn btn-ghost" type="button" :disabled="!revisionTemplateId || revisionTemplatesLoading || revising || emailSending" @click="reapplyRevisionTemplate">重新套用模板</button>
            </div>
            <p v-if="revisionTemplateError" class="feedback error" role="alert">{{ revisionTemplateError }}</p>
          </div>
          <div class="form-field" style="grid-column:1 / -1"><label>Offer 内容</label><RichTextEditor v-model="reviseForm.content" :variables="templateVariables" :min-height="220" /></div>
        </div>
      </div>
      <div class="dialog-buttons offer-revise-footer">
          <button class="btn btn-ghost" type="button" :disabled="revising || emailSending" @click="showRevise = false">取消</button>
          <button v-if="reviseIntent === 'send'" class="btn btn-primary" type="button" :disabled="revising || emailSending" @click="previewRevisionEmail">{{ revising ? '保存中...' : emailSending ? '处理中...' : '预览邮件' }}</button>
          <button v-else class="btn btn-primary" type="button" :disabled="revising" @click="submitRevise()">{{ revising ? '保存中...' : '保存修订' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.offer-form-heading{grid-column:1 / -1;margin:12px 0 0;padding-bottom:8px;border-bottom:1px solid var(--border,#dbe3ef);font-size:14px}
.salary-body-review{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:1.6;color:#a34c15}
.salary-body-review input{width:16px;height:16px;flex:none;margin-top:3px}
:global(html:has(.offer-scroll-lock)) { overflow: hidden; }
:global(html:has(.offer-scroll-gutter)) { scrollbar-gutter: stable; }
.revision-template-controls { display: flex; flex-wrap: wrap; gap: 8px; }
.revision-template-controls select { flex: 1 1 180px; min-width: 0; }
.revision-template-controls button { flex: 0 0 auto; }
.info-list dd.confirmation-pending { color: #b45309; font-weight: 600; }
.email-final-preview iframe { display: block; width: 100%; min-height: 320px; border: 1px solid var(--border, #ddd); background: #fff; }
.email-final-preview { min-width: 0; }

.offer-detail-layout {
  display: grid;
  grid-template-columns: minmax(280px, 0.85fr) minmax(0, 1.65fr);
  gap: 16px;
  align-items: start;
}
.offer-detail-layout > .card {
  min-width: 0;
  padding: 18px;
  border: 1px solid var(--border, #dbe3ef);
  border-radius: 8px;
  background: var(--card, #fff);
  box-shadow: var(--shadow, 0 4px 12px rgba(15, 23, 42, 0.04));
}
.offer-summary-card { grid-column: 1; }
.offer-actions-card { grid-column: 2; }
.offer-content-card,
.offer-history-card,
.offer-audit-card,
.offer-detail-footer { grid-column: 1 / -1; }
.info-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 18px;
  margin: 0;
}
.info-list > div { min-width: 0; }
.info-list dt { color: var(--muted, #64748b); font-size: 12px; }
.info-list dd { min-width: 0; margin: 4px 0 0; color: var(--text, #1e293b); overflow-wrap: anywhere; }
.offer-content-copy { margin: 0; color: var(--text, #1e293b); line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.content-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.content-section-heading .section-title { margin: 0; }
.offer-detail-footer { display: flex; justify-content: flex-end; }
.floating-resend-button { position: fixed; right: 28px; bottom: 24px; z-index: 30; min-width: 144px; min-height: 48px; box-shadow: 0 6px 18px rgba(15, 23, 42, 0.22); }
.offer-email-dialog { width: min(760px, calc(100vw - 32px)); max-height: min(88vh, 820px); overflow-y: auto; }
.offer-scroll-lock > .offer-email-dialog { display: flex; flex-direction: column; overflow: hidden; padding: 0; }
.offer-email-header { flex: 0 0 auto; padding: 12px 18px; border-bottom: 1px solid var(--border, #dbe3ef); }
.offer-email-title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.offer-email-title-row h3 { margin: 0; }
.offer-email-title-row .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: 0 0 auto; min-width: 96px; white-space: nowrap; }
.offer-email-header .feedback { margin: 8px 0 0; overflow-wrap: anywhere; }
.offer-email-body { min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; padding: 12px 18px 18px; }
.offer-revise-dialog { display: flex; flex-direction: column; width: min(760px, calc(100vw - 32px)); max-width: 760px; max-height: calc(100dvh - 32px); overflow: hidden; padding: 0; }
.offer-revise-header { flex: 0 0 auto; padding: 18px 20px 12px; border-bottom: 1px solid var(--border, #dbe3ef); }
.offer-revise-header h3 { margin: 0; }
.offer-revise-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 16px 20px; }
.offer-revise-footer { flex: 0 0 auto; position: sticky; bottom: 0; margin: 0; padding: 12px 20px; border-top: 1px solid var(--border, #dbe3ef); background: #fff; }
.attachment-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 8px; }
.attachment-row span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.template-variables { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.template-variables code { padding: 3px 6px; border: 1px solid var(--border, #dbe3ef); border-radius: 4px; color: var(--muted, #64748b); font-size: 12px; }
@media (max-width: 900px) {
  .offer-detail-layout { grid-template-columns: 1fr; }
  .offer-summary-card,
  .offer-actions-card,
  .offer-content-card,
  .offer-history-card,
  .offer-audit-card,
  .offer-detail-footer { grid-column: 1; }
}
@media (max-width: 560px) {
  .info-list { grid-template-columns: 1fr; }
  .offer-detail-layout > .card { padding: 14px; }
  .offer-detail-footer { justify-content: stretch; }
  .offer-detail-footer .btn { width: 100%; }
  .floating-resend-button { right: 16px; bottom: 16px; min-width: 132px; }
}
</style>
