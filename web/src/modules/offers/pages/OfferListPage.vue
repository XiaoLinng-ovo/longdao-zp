<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { offerSalaryVariables } from '@smartrecruit-pro/contracts'
import { useRouter } from 'vue-router'
import {
  createOffer,
  getOffer,
  createOfferTemplate,
  deleteOfferTemplate,
  listOfferContextRows,
  listOfferTemplates,
  listOffers,
  loadApplicationsForOffer,
  offerAction,
  updateOfferTemplate,
  OFFER_ACTION_LABEL,
  OFFER_STATUS_LABEL,
  offerStatusCode,
  type ApiApplication,
  type ApiOfferTemplate,
  type ApiOfferVersion,
  type OfferAction,
  type OfferStatus,
  type OfferRow,
} from '../api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { applicationOptionLabel, employmentTypeLabel } from '../../../shared/utils/labels'
import { loadDepartments, type ApiDepartment } from '../../requisitions/api'
import { loadJobs, type JobView } from '../../jobs/api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import PageFeedback from '../../../shared/components/workflow/PageFeedback.vue'
import OfferTable from '../components/OfferTable.vue'
import RichTextEditor from '../components/RichTextEditor.vue'
import { bindOfferContent, synchronizeOfferContent } from '../utils/offerContent'
import OfferTemplateFields from '../components/OfferTemplateFields.vue'
import OfferSalaryFields from '../components/OfferSalaryFields.vue'
import { salaryFormError, salaryPayload } from '../utils/salary'
import { additionalOfferVariables, offerTemplateFieldValues, restoreOfferTemplateFields, type OfferTemplateFields as TemplateFields } from '../utils/templateFields'
import { hasVisibleRichText, normalizeRichHtml, normalizeReportingLocationTemplate, pinOfferEmailContent, renderHtmlTemplate } from '../utils/richText'

const rows = ref<OfferRow[]>([])
const router = useRouter()
const loading = ref(true)
const error = ref('')
const feedback = ref('')
const actingId = ref('')

const applications = ref<ApiApplication[]>([])
const eligibleApplications = ref<ApiApplication[]>([])
const loadingEligibleApplications = ref(false)
let eligibilityRequest = 0
const offerTemplates = ref<ApiOfferTemplate[]>([])
const showTemplateManager = ref(false)
const savingTemplate = ref(false)
const templateUploadInput = ref<HTMLInputElement | null>(null)
const templateForm = ref({ id: '', name: '', filename: '', content: '', isActive: true, isDefault: false })
const departments = ref<ApiDepartment[]>([])
const jobs = ref<JobView[]>([])
const showCreate = ref(false)
const creating = ref(false)
const materialOptions = [
  { value: 'graduation_certificate', label: '毕业证书、学位证书' },
  { value: 'id_card', label: '身份证' },
  { value: 'previous_employment_release', label: '上家公司劳动合同解除证明或者离职证明' },
  { value: 'previous_employment_payroll', label: '上家单位一年工资流水' },
  { value: 'photo', label: '一寸照片一张' },
  { value: 'medical_report', label: '体检报告' },
  { value: 'bank_card', label: '工资卡' },
  { value: 'other', label: '其他' },
] as const
type MaterialCode = typeof materialOptions[number]['value']
const materialLabelMap = new Map<string, string>(materialOptions.map((item) => [item.value, item.label]))
const createForm = ref({
  applicationId: '',
  jobId: '',
  positionTitle: '',
  departmentId: '',
  employmentType: 'full_time',
  startDate: '',
  reportingLocation: '',
  invoiceTitle: '',
  taxNumber: '',
  templateFields: { probationSalaryMonths: '0', formalSalaryStartMonth: '1' } as TemplateFields,
  probationSalaryAmount: 0,
  baseSalaryAmount: 0,
  currency: 'CNY',
  bonusAmount: 0,
  equity: '',
  benefitsText: '',
  materials: [] as MaterialCode[],
  bankName: '',
  otherMaterial: '',
  extraMaterials: [] as string[],
  content: '',
  templateId: '',
})
const materialsExpanded = ref(false)
const extraMaterialOptions = ref<string[]>([])
const createContentManuallyEdited = ref(false)
const salaryBodyReviewRequired = ref(false)
const salaryBodyReviewed = ref(false)
watch(() => JSON.stringify([createForm.value.templateFields.probationDuration, createForm.value.templateFields.probationSalaryMonths,
  createForm.value.templateFields.formalSalaryStartMonth, createForm.value.baseSalaryAmount, createForm.value.probationSalaryAmount, createForm.value.employmentType]), () => {
  if (showCreate.value && createContentManuallyEdited.value) { salaryBodyReviewRequired.value = true; salaryBodyReviewed.value = false }
}, { flush: 'sync' })
let createDraftKey = ''
const createDrafts = new Map<string, { form: typeof createForm.value; manuallyEdited: boolean; expanded: boolean; extraMaterialOptions: string[]; salaryReviewRequired: boolean }>()
const templateVariables = [
  { value: '{{candidateName}}', label: '候选人姓名' },
  { value: '{{入职材料}}', label: '入职材料' },
  ...additionalOfferVariables,
  { value: '{{jobTitle}}', label: '岗位名称' },
  { value: '{{department}}', label: '所属部门' },
  { value: '{{employmentType}}', label: '用工类型' },
  { value: '{{startDate}}', label: '入职日期' },
  { value: '{{报到地点}}', label: '报到地点' },
  { value: '{{发票抬头}}', label: '发票抬头' },
  { value: '{{企业税号}}', label: '企业税号' },
  { value: '{{probationSalary}}', label: '初期月薪（兼容旧模板）' },
  { value: '{{baseSalary}}', label: '正常月薪' },
  { value: '{{bonus}}', label: '奖金' },
  { value: '{{benefits}}', label: '福利' },
]

function clearFlags() { error.value = ''; feedback.value = '' }
async function refresh() {
  loading.value = true
  clearFlags()
  try {
    const [offerRows, eligible, templates] = await Promise.all([
      listOfferContextRows(),
      loadApplicationsForOffer(true),
      listOfferTemplates().catch(() => []),
      ensureApplications(),
    ])
    rows.value = offerRows
    eligibleApplications.value = eligible
    offerTemplates.value = templates
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
function applyJobSelection(jobId: string) {
  const job = jobs.value.find((item) => item.id === jobId)
  const form = createForm.value
  form.jobId = jobId
  if (!job) return
  form.positionTitle = job.title
  const department = departments.value.find((item) => item.name === job.department)
  if (department) form.departmentId = department.id
}

function findJobForApplication(application: ApiApplication): JobView | undefined {
  return jobs.value.find((job) => job.entityId === application.jobId || job.id === application.jobId)
}

function materialDetail(code: string, bankName = '', otherMaterial = ''): string {
  if (code === 'bank_card' && bankName.trim()) return `${bankName.trim()}工资卡`
  if (code === 'other' && otherMaterial.trim()) return otherMaterial.trim()
  return materialLabelMap.get(code) ?? code
}

function serializeMaterials(materials: readonly string[], bankName = '', otherMaterial = '', extraMaterials: readonly string[] = []): string[] {
  return materials.map((code) => {
    if (code === 'bank_card' && bankName.trim()) return `bank_card:${bankName.trim()}`
    if (code === 'other' && otherMaterial.trim()) return `other:${otherMaterial.trim()}`
    return code
  }).concat(extraMaterials)
}

function materialText(materials: readonly string[], bankName = '', otherMaterial = '', extraMaterials: readonly string[] = []): string {
  const labels = materials.map(code => materialDetail(code, bankName, otherMaterial)).concat(extraMaterials.map(item => materialSummary([item])))
  return labels.map((label, index) => `${index + 1}. ${label}；`).join('\n')
}

function materialSummary(materials: readonly string[]): string {
  return materials.map((item) => {
    const [code, ...detailParts] = item.split(':')
    const detail = detailParts.join(':').trim()
    if (code === 'bank_card' && detail) return `${detail}工资卡`
    if (code === 'other' && detail) return detail
    return materialLabelMap.get(code) ?? item
  }).join('、')
}

function reportingDate(fields: TemplateFields, fallback = ''): string {
  const value = fields.reportingTime ?? ''
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(value)) return value.slice(0, 10)
  return fallback
}

const selectedMaterialCount = computed(() => createForm.value.materials.length + createForm.value.extraMaterials.length)

function templateValues(): Record<string, string> {
  const application = eligibleApplications.value.find((item) => item.id === createForm.value.applicationId)
  const job = application ? findJobForApplication(application) : undefined
  const department = departments.value.find((item) => item.id === createForm.value.departmentId)
  const materials = serializeMaterials(createForm.value.materials, createForm.value.bankName, createForm.value.otherMaterial, createForm.value.extraMaterials)
  return {
    ...offerTemplateFieldValues(createForm.value.templateFields),
    ...offerSalaryVariables(createForm.value.templateFields, createForm.value.baseSalaryAmount, createForm.value.probationSalaryAmount),
    candidateName: application?.candidateName ?? '',
    jobTitle: createForm.value.positionTitle || application?.jobTitle || '',
    department: department?.name ?? job?.department ?? '',
    employmentType: employmentTypeLabel(createForm.value.employmentType),
    startDate: reportingDate(createForm.value.templateFields, createForm.value.startDate),
    reportDate: reportingDate(createForm.value.templateFields, createForm.value.startDate),
    '报到日期': reportingDate(createForm.value.templateFields, createForm.value.startDate),
    invoiceTitle: createForm.value.invoiceTitle,
    '发票抬头': createForm.value.invoiceTitle,
    taxNumber: createForm.value.taxNumber,
    '企业税号': createForm.value.taxNumber,
    reportingLocation: createForm.value.reportingLocation,
    '报到地点': createForm.value.reportingLocation,
    '报到地址': createForm.value.reportingLocation,
    '报到地点/房间号': createForm.value.reportingLocation,
    probationSalary: createForm.value.probationSalaryAmount > 0 ? String(createForm.value.probationSalaryAmount) : '',
    baseSalary: createForm.value.baseSalaryAmount > 0 ? String(createForm.value.baseSalaryAmount) : '',
    bonus: createForm.value.bonusAmount > 0 ? String(createForm.value.bonusAmount) : '',
    benefits: createForm.value.benefitsText,
    materials: materialText(createForm.value.materials, createForm.value.bankName, createForm.value.otherMaterial, createForm.value.extraMaterials),
    onboardingMaterials: materialText(createForm.value.materials, createForm.value.bankName, createForm.value.otherMaterial, createForm.value.extraMaterials),
    '入职材料': materialText(createForm.value.materials, createForm.value.bankName, createForm.value.otherMaterial, createForm.value.extraMaterials),
    otherOnboardingMaterials: materialSummary(materials),
    '其他入职材料': materialSummary(materials),
    '工资卡银行名称': createForm.value.bankName,
    bankName: createForm.value.bankName,
    photoQuantity: createForm.value.materials.includes('photo') ? '1' : '',
    '照片数量': createForm.value.materials.includes('photo') ? '1' : '',
    companyName: '',
  }
}

function applyOfferTemplate(templateId = createForm.value.templateId) {
  const template = offerTemplates.value.find((item) => item.id === templateId && item.isActive)
  if (!template && templateId) return
  const content = template?.content ?? '<p>{{candidateName}}，您好：</p><h2>录用通知</h2><p>岗位：{{jobTitle}}；部门：{{department}}。</p><p>报到日期：{{报到日期}}；报到时间：{{报到时间}}；报到地点：{{报到地点}}。</p><p>薪资安排：{{薪资安排说明}}。</p><p>福利：{{benefits}}</p><p>入职材料：{{入职材料}}</p>'
  createForm.value.templateId = template?.id ?? ''
  createForm.value.content = bindOfferContent(normalizeReportingLocationTemplate(content), templateValues())
  createContentManuallyEdited.value = false
  salaryBodyReviewRequired.value = false
  salaryBodyReviewed.value = false
}

function applyOfferTemplateIfClean() {
  if (!createContentManuallyEdited.value) applyOfferTemplate()
  else if (createContentManuallyEdited.value) createForm.value.content = synchronizeOfferContent(createForm.value.content, templateValues())
}

function prefillCreateApplication(applicationId: string) {
  createForm.value.applicationId = applicationId
  const application = applications.value.find((item) => item.id === applicationId) ?? eligibleApplications.value.find((item) => item.id === applicationId)
  if (!application) return
  const job = findJobForApplication(application)
  if (job) applyJobSelection(job.id)
  else createForm.value.positionTitle = application.jobTitle ?? ''
  applyOfferTemplate()
}

function resetCreateForm() {
  createContentManuallyEdited.value = false
  salaryBodyReviewRequired.value = false
  salaryBodyReviewed.value = false
  createForm.value = {
    applicationId: '',
    jobId: '',
    positionTitle: '',
    departmentId: '',
    employmentType: 'full_time',
    startDate: '',
    reportingLocation: '',
  invoiceTitle: '',
  taxNumber: '',
  templateFields: { probationSalaryMonths: '0', formalSalaryStartMonth: '1' } as TemplateFields,
    probationSalaryAmount: 0,
    baseSalaryAmount: 0,
    currency: 'CNY',
    bonusAmount: 0,
    equity: '',
    benefitsText: '',
    materials: [],
    bankName: '',
    otherMaterial: '',
    extraMaterials: [],
    content: '',
    templateId: offerTemplates.value.find((item) => item.isActive && item.isDefault)?.id ?? '',
  }
  createContentManuallyEdited.value = false
  materialsExpanded.value = false
  extraMaterialOptions.value = []
}

async function openCreate(application?: ApiApplication, source?: ApiOfferVersion, draftKey = application?.id ?? '') {
  clearFlags()
  resetCreateForm()
  createDraftKey = draftKey
  showCreate.value = true
  const request = ++eligibilityRequest
  eligibleApplications.value = []
  loadingEligibleApplications.value = true
  try {
    const [eligible, templates] = await Promise.all([loadApplicationsForOffer(true), listOfferTemplates().catch(() => []), ensureApplications()])
    if (request === eligibilityRequest) {
      eligibleApplications.value = eligible
      offerTemplates.value = templates
      createForm.value.templateId = templates.find((item) => item.isActive && item.isDefault)?.id ?? ''
      const draft = createDrafts.get(draftKey)
      if (draft) {
        createForm.value = { ...draft.form, templateFields: { ...draft.form.templateFields }, materials: [...draft.form.materials], extraMaterials: [...draft.form.extraMaterials] }
        createContentManuallyEdited.value = draft.manuallyEdited
        salaryBodyReviewRequired.value = draft.salaryReviewRequired
        materialsExpanded.value = draft.expanded
        extraMaterialOptions.value = [...draft.extraMaterialOptions]
      } else if (source) {
        const comp = source.compensation
        const bank = source.materials.find(item => item.startsWith('bank_card:'))
        const other = source.materials.find(item => item.startsWith('other:'))
        const standard = source.materials.filter(item => materialLabelMap.has(item)) as MaterialCode[]
        createForm.value = {
          ...createForm.value, applicationId: application?.id ?? '',
          jobId: jobs.value.find(item => item.title === source.positionTitle)?.id ?? '',
          positionTitle: source.positionTitle, departmentId: source.departmentId, employmentType: source.employmentType,
          startDate: source.startDate ?? '', reportingLocation: source.reportingLocation ?? '',
          invoiceTitle: source.invoiceTitle ?? '', taxNumber: source.taxNumber ?? '',
          templateFields: restoreOfferTemplateFields(source.templateFields, source.startDate),
          probationSalaryAmount: comp.probationSalary?.amount ?? 0, baseSalaryAmount: comp.baseSalary.amount,
          currency: comp.baseSalary.currency, bonusAmount: comp.bonus?.amount ?? 0, equity: comp.equity ?? '',
          benefitsText: source.benefits.join('，'), materials: [...standard, ...(bank ? ['bank_card' as const] : []), ...(other ? ['other' as const] : [])],
          bankName: bank?.slice(10) ?? '', otherMaterial: other?.slice(6) ?? '',
          extraMaterials: source.materials.filter(item => !materialLabelMap.has(item) && item !== bank && item !== other),
          content: source.content, templateId: '',
        }
        createForm.value.content = bindOfferContent(source.content, templateValues(), true)
        extraMaterialOptions.value = [...createForm.value.extraMaterials]
        createContentManuallyEdited.value = true
      } else if (application && eligibleApplications.value.some((item) => item.id === application.id)) prefillCreateApplication(application.id)
      else applyOfferTemplate()
    }
  } catch (cause) {
    if (request === eligibilityRequest) error.value = describeApiFailure(cause, '读取复试通过的申请失败').message
  } finally {
    if (request === eligibilityRequest) loadingEligibleApplications.value = false
  }
}

async function openRecreate(row: OfferRow) {
  clearFlags()
  try {
    const detail = await getOffer(row.entityId)
    if (!detail.version) throw new Error('未找到原 Offer 版本，无法恢复已保存内容')
    await openCreate({ id: detail.offer.applicationId } as ApiApplication, detail.version, 'recreate:' + detail.offer.id)
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取原 Offer 失败').message
  }
}

function closeCreate() {
  if (creating.value) return
  createDrafts.set(createDraftKey, { form: { ...createForm.value, templateFields: { ...createForm.value.templateFields }, materials: [...createForm.value.materials], extraMaterials: [...createForm.value.extraMaterials] }, manuallyEdited: createContentManuallyEdited.value, expanded: materialsExpanded.value, extraMaterialOptions: [...extraMaterialOptions.value], salaryReviewRequired: salaryBodyReviewRequired.value })
  showCreate.value = false
  eligibilityRequest++
}

function resetTemplateForm() {
  templateForm.value = { id: '', name: '', filename: '', content: '', isActive: true, isDefault: false }
  if (templateUploadInput.value) templateUploadInput.value.value = ''
}

async function openTemplateManager() {
  clearFlags()
  showTemplateManager.value = true
  resetTemplateForm()
  try {
    offerTemplates.value = await listOfferTemplates()
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取 Offer 模板失败').message
  }
}

function editTemplate(template: ApiOfferTemplate) {
  templateForm.value = { id: template.id, name: template.name, filename: template.filename, content: template.content, isActive: template.isActive, isDefault: template.isDefault }
}

async function onTemplateFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (!/\.(?:md|html?|txt)$/iu.test(file.name)) { error.value = '仅支持上传 .md、.html、.htm 或 .txt 格式的 Offer 模板'; input.value = ''; return }
  try {
    templateForm.value.filename = file.name
    templateForm.value.name = file.name.replace(/\.(?:md|html?|txt)$/iu, '') || 'Offer 模板'
    templateForm.value.content = await file.text()
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取模板文件失败').message
  }
}

async function saveTemplate() {
  if (savingTemplate.value) return
  const form = templateForm.value
  if (!form.name.trim() || !form.filename.trim()) { error.value = '请填写模板名称并上传或填写模板文件名'; return }
  if (!/\.(?:md|html?|txt)$/iu.test(form.filename.trim())) { error.value = '模板文件必须为 .md、.html、.htm 或 .txt 格式'; return }
  if (form.content.length > 50_000) { error.value = '模板内容不能超过 50000 个字符'; return }
  savingTemplate.value = true
  clearFlags()
  try {
    const input = { name: form.name.trim(), filename: form.filename.trim(), content: form.content, isActive: form.isActive, isDefault: form.isDefault }
    if (form.id) await updateOfferTemplate(form.id, input)
    else await createOfferTemplate(input)
    offerTemplates.value = await listOfferTemplates()
    resetTemplateForm()
    feedback.value = 'Offer 模板已保存'
  } catch (cause) {
    error.value = describeApiFailure(cause, '保存 Offer 模板失败').message
  } finally {
    savingTemplate.value = false
  }
}

async function setDefaultTemplate(template: ApiOfferTemplate) {
  clearFlags()
  try {
    await updateOfferTemplate(template.id, { isActive: true, isDefault: true })
    offerTemplates.value = await listOfferTemplates()
    feedback.value = '默认 Offer 模板已更新'
  } catch (cause) {
    error.value = describeApiFailure(cause, '设置默认模板失败').message
  }
}

async function toggleTemplate(template: ApiOfferTemplate) {
  clearFlags()
  try {
    await updateOfferTemplate(template.id, { isActive: !template.isActive })
    offerTemplates.value = await listOfferTemplates()
  } catch (cause) {
    error.value = describeApiFailure(cause, '更新模板状态失败').message
  }
}

async function removeTemplate(template: ApiOfferTemplate) {
  clearFlags()
  try {
    await deleteOfferTemplate(template.id)
    offerTemplates.value = await listOfferTemplates()
    if (templateForm.value.id === template.id) resetTemplateForm()
    feedback.value = 'Offer 模板已删除'
  } catch (cause) {
    error.value = describeApiFailure(cause, '删除 Offer 模板失败').message
  }
}

function splitList(text: string): string[] {
  return text.split(/[，,、\n]/).map((s) => s.trim()).filter(Boolean)
}

async function submitCreate() {
  if (creating.value) return
  const form = createForm.value
  if (!form.applicationId.trim()) { error.value = '请选择申请'; return }
  if (!eligibleApplications.value.some(item => item.id === form.applicationId)) { error.value = '请选择第二轮复试已通过的申请'; return }
  if (!form.positionTitle.trim()) { error.value = '请填写职位名称'; return }
  if (!form.departmentId.trim()) { error.value = '请填写部门'; return }
  const salaryError = salaryFormError(form.employmentType, form.templateFields, form.baseSalaryAmount, form.probationSalaryAmount)
  if (salaryError) { error.value = salaryError; return }
  if (salaryBodyReviewRequired.value && !salaryBodyReviewed.value) { error.value = '请核对手写正文中的薪资安排后再保存'; return }
  if (form.materials.includes('other') && !form.otherMaterial.trim()) { error.value = '请填写其他入职材料'; return }
  if (!hasVisibleRichText(form.content)) { error.value = '请填写 Offer 内容'; return }

  creating.value = true
  clearFlags()
  try {
    await createOffer({
      applicationId: form.applicationId,
      positionTitle: form.positionTitle.trim(),
      departmentId: form.departmentId.trim(),
      employmentType: form.employmentType,
      startDate: reportingDate(form.templateFields, form.startDate) || undefined,
      reportingLocation: form.reportingLocation.trim() || undefined,
      invoiceTitle: form.invoiceTitle.trim(),
      taxNumber: form.taxNumber.trim(),
      ...salaryPayload(form.employmentType, form.templateFields, form.probationSalaryAmount),
      baseSalary: { amount: form.baseSalaryAmount, currency: 'CNY' },
      bonus: form.bonusAmount > 0 ? { amount: form.bonusAmount, currency: 'CNY' } : undefined,
      equity: form.equity.trim() || undefined,
      benefits: splitList(form.benefitsText),
      materials: serializeMaterials(form.materials, form.bankName, form.otherMaterial, form.extraMaterials),
      content: form.content.trim(),
    })
    feedback.value = 'Offer 草稿已创建'
    createDrafts.delete(createDraftKey)
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

function openDetail(row: OfferRow) {
  void router.push({ name: 'offer-detail', params: { id: row.entityId } })
}

function openEmailComposer(row: OfferRow) {
  void router.push({ name: 'offer-detail', params: { id: row.entityId }, query: { compose: 'email' } })
}

function openRevise(row: OfferRow) {
  void router.push({ name: 'offer-detail', params: { id: row.entityId }, query: { edit: '1' } })
}

const templatePreviewHtml = computed(() => renderHtmlTemplate(pinOfferEmailContent(templateForm.value.content || templateForm.value.name), {
  ...offerTemplateFieldValues({ probationDuration: '3个月', probationSalaryMonths: '1', formalSalaryStartMonth: '2' }),
  ...offerSalaryVariables({ probationDuration: '3个月', probationSalaryMonths: '1', formalSalaryStartMonth: '2' }, 15000, 12000),
  candidateName: '候选人姓名', '候选人姓名': '候选人姓名', '称谓': '您好', jobTitle: '岗位名称', department: '所属部门', employmentType: '全职', startDate: '2026-11-02', reportDate: '2026-11-02',
  reportingLocation: '杭州市余杭区城投未来之星 C2 幢 21 楼', '报到日期': '2026-11-02', '报到地点': '杭州市余杭区城投未来之星 C2 幢 21 楼',
  invoiceTitle: '发票抬头', '发票抬头': '发票抬头', taxNumber: '企业税号', '企业税号': '企业税号',
  probationSalary: '12,000', baseSalary: '15,000', bonus: '2,000', benefits: '五险一金、带薪年假', '入职材料': '1. 身份证；\n2. 招商银行工资卡；', companyName: '公司名称',
}))

let routeReady = false
let routeDisposed = false
let routeRequest = 0
async function handleOfferRoute() {
  const request = ++routeRequest
  const recreateOfferId = router.currentRoute.value.query.recreateOfferId
  if (typeof recreateOfferId === 'string') {
    await openRecreate({ entityId: recreateOfferId } as OfferRow)
    if (request !== routeRequest) return
    const query = { ...router.currentRoute.value.query }; delete query.recreateOfferId
    await router.replace({ path: '/offers', query })
    return
  }
  const applicationId = typeof router.currentRoute.value.query.createApplicationId === 'string'
    ? router.currentRoute.value.query.createApplicationId
    : ''
  if (!applicationId) return
  try {
    const [currentOffers, eligible] = await Promise.all([listOfferContextRows(), loadApplicationsForOffer(true)])
    if (request !== routeRequest) return
    const existing = currentOffers.find(item => item.applicationId === applicationId && item.status !== 'cancelled')
    if (existing) { await router.replace({ name: 'offer-detail', params: { id: existing.entityId } }); return }
    const application = eligible.find(item => item.id === applicationId)
    if (!application) { error.value = '该申请不存在、无权访问或尚不符合 Offer 创建条件'; return }
    await openCreate(application)
    if (request !== routeRequest) return
    const query = { ...router.currentRoute.value.query }; delete query.createApplicationId
    await router.replace({ path: '/offers', query })
  } catch (cause) { error.value = describeApiFailure(cause, '读取录用申请失败，请刷新重试').message }
}
onMounted(async () => { await refresh(); if (routeDisposed) return; routeReady = true; await handleOfferRoute() })
onUnmounted(() => { routeDisposed = true; routeReady = false; routeRequest++; eligibilityRequest++ })
watch(() => [router.currentRoute.value.query.createApplicationId, router.currentRoute.value.query.recreateOfferId], () => {
  if (routeReady) void handleOfferRoute()
})
</script>

<template>
  <PageHeader title="Offer 管理" description="创建、发送 Offer，并跟踪候选人响应与入职归档">
    <div class="inline-actions">
      <button class="btn btn-primary" type="button" @click="() => openCreate()">新建 Offer</button>
      <button class="btn btn-ghost" type="button" @click="openTemplateManager">Offer 模板</button>
      <button class="btn btn-ghost" type="button" @click="refresh">刷新</button>
    </div>
  </PageHeader>

  <PageFeedback :feedback="feedback" :error="error" @clear-feedback="feedback = ''" @clear-error="error = ''" />
  <div v-if="loading" class="loading-note">正在读取 Offer...</div>
  <template v-else>
    <section v-if="eligibleApplications.length" class="offer-queue" aria-labelledby="offer-queue-title">
      <div class="offer-queue-head">
        <div>
          <h2 id="offer-queue-title">待办理 Offer</h2>
          <p>第二轮复试通过或取消 Offer 后可重新办理的候选人</p>
        </div>
        <span>{{ eligibleApplications.length }} 人</span>
      </div>
      <div class="offer-queue-table-wrap">
        <table class="offer-queue-table">
          <thead><tr><th>候选人</th><th>岗位</th><th>申请编号</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="application in eligibleApplications" :key="application.id">
              <td>{{ application.candidateName || '-' }}</td>
              <td>{{ application.jobTitle || '-' }}</td>
              <td>{{ application.code }}</td>
              <td><button class="btn btn-primary btn-compact" type="button" @click="openCreate(application)">填写 Offer</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <OfferTable :rows="rows" :acting-id="actingId" @action="runAction" @send="openEmailComposer" @open="openDetail" @revise="openRevise" @recreate="openRecreate" />
  </template>

  <div v-if="showCreate" class="overlay" role="presentation">
    <div class="dialog offer-create-dialog" role="dialog" aria-modal="true" aria-labelledby="offer-create-title">
      <div class="offer-create-header">
        <h3 id="offer-create-title">新建 Offer</h3>
        <div class="offer-create-actions">
          <button class="btn btn-ghost" type="button" :disabled="creating" @click="closeCreate">取消</button>
          <button class="btn btn-primary" type="button" :disabled="creating || loadingEligibleApplications || !eligibleApplications.length" @click="submitCreate">{{ creating ? '保存中...' : '保存草稿' }}</button>
        </div>
      </div>
      <div class="offer-create-body">
      <div v-if="error" class="error-note">{{ error }}</div>
      <div class="form-grid">
      <h4 class="offer-form-heading">录用信息</h4>
      <div class="form-field">
        <label>申请</label>
        <select v-model="createForm.applicationId" :disabled="loadingEligibleApplications || !eligibleApplications.length" @change="prefillCreateApplication(createForm.applicationId)">
          <option value="" disabled>{{ loadingEligibleApplications ? '正在读取申请...' : eligibleApplications.length ? '选择申请' : '暂无可办理的申请' }}</option>
          <option v-for="app in eligibleApplications" :key="app.id" :value="app.id">{{ applicationOptionLabel(app) }}</option>
        </select>
      </div>
      <div class="form-field">
        <label>岗位</label>
        <select :value="createForm.jobId" @change="applyJobSelection(($event.target as HTMLSelectElement).value)">
          <option value="" disabled>选择岗位</option>
          <option v-for="job in jobs" :key="job.id" :value="job.id">{{ job.title }}（{{ job.department }}）</option>
        </select>
      </div>
      <div class="form-field"><label>部门</label><select v-model="createForm.departmentId"><option value="" disabled>请选择部门</option><option v-for="dept in departments" :key="dept.id" :value="dept.id">{{ dept.name }}</option></select></div>
      <div class="form-field">
        <label>用工类型</label>
        <select v-model="createForm.employmentType">
          <option value="full_time">全职</option>
          <option value="internship">实习</option>
        </select>
      </div>
      <h4 class="offer-form-heading">报到安排</h4>
      <div class="form-field"><label>报到地点</label><input v-model="createForm.reportingLocation" maxlength="300" placeholder="请输入候选人报到地点" @input="applyOfferTemplateIfClean" /></div>
      <OfferTemplateFields v-model="createForm.templateFields" :employment-type="createForm.employmentType" @update:modelValue="$nextTick(applyOfferTemplateIfClean)" />
      <OfferSalaryFields v-model:fields="createForm.templateFields" v-model:base-salary="createForm.baseSalaryAmount" v-model:initial-salary="createForm.probationSalaryAmount" :employment-type="createForm.employmentType" @update:fields="$nextTick(applyOfferTemplateIfClean)" @update:base-salary="$nextTick(applyOfferTemplateIfClean)" @update:initial-salary="$nextTick(applyOfferTemplateIfClean)" />
      <h4 class="offer-form-heading">福利与材料</h4>
      <div class="form-field"><label>奖金（元，可选）</label><input v-model.number="createForm.bonusAmount" type="number" min="0" @input="applyOfferTemplateIfClean" /></div>
      <div class="form-field"><label>股权（可选）</label><input v-model="createForm.equity" placeholder="如 2000 RSU" /></div>
      <div class="form-field"><label>发票抬头</label><input v-model="createForm.invoiceTitle" maxlength="200" placeholder="请输入发票抬头" @input="applyOfferTemplateIfClean" /></div>
      <div class="form-field"><label>企业税号</label><input v-model="createForm.taxNumber" maxlength="100" placeholder="请输入企业税号" @input="applyOfferTemplateIfClean" /></div>
      <div class="form-field" style="grid-column:1 / -1"><label>福利（逗号分隔）</label><input v-model="createForm.benefitsText" placeholder="五险一金、带薪年假" @change="applyOfferTemplateIfClean" /></div>
       <details class="form-field offer-materials-field" style="grid-column:1 / -1" :open="materialsExpanded" @toggle="materialsExpanded = ($event.target as HTMLDetailsElement).open">
         <summary>入职材料 <span class="material-count">{{ selectedMaterialCount ? `已选 ${selectedMaterialCount} 项` : '未选择' }}</span></summary>
         <div class="material-options">
           <label v-for="material in materialOptions" :key="material.value">
             <input v-model="createForm.materials" type="checkbox" :value="material.value" @change="applyOfferTemplateIfClean" />
             <span>{{ material.label }}</span>
             <input v-if="material.value === 'bank_card' && createForm.materials.includes('bank_card')" v-model="createForm.bankName" class="material-bank-input" placeholder="请输入银行名称" @input="applyOfferTemplateIfClean" />
             <input v-if="material.value === 'other' && createForm.materials.includes('other')" v-model="createForm.otherMaterial" class="material-custom-input" maxlength="120" placeholder="请输入其他入职材料" @input="applyOfferTemplateIfClean" />
           </label>
           <label v-for="material in extraMaterialOptions" :key="material">
             <input v-model="createForm.extraMaterials" type="checkbox" :value="material" @change="applyOfferTemplateIfClean" />
             <span>{{ materialSummary([material]) }}</span>
           </label>
         </div>
       </details>
       <h4 class="offer-form-heading">Offer 正文</h4>
       <div class="form-field" style="grid-column:1 / -1">
         <label>Offer 模板</label>
         <div class="template-select-row">
           <select v-model="createForm.templateId" @change="applyOfferTemplate()">
             <option value="">基础录用正文</option>
             <option v-for="template in offerTemplates.filter((item) => item.isActive)" :key="template.id" :value="template.id">{{ template.name }}{{ template.isDefault ? '（默认）' : '' }}</option>
           </select>
           <button class="btn btn-ghost btn-compact" type="button" :disabled="!createForm.templateId" @click="applyOfferTemplate()">重新套用</button>
         </div>
       </div>
      <div class="form-field" style="grid-column:1 / -1"><label>Offer 内容</label><RichTextEditor v-model="createForm.content" :variables="templateVariables" :min-height="260" @update:model-value="createContentManuallyEdited = true" /><small v-if="createContentManuallyEdited" class="list-muted">正文已人工调整，上方字段变化不会自动覆盖。</small></div>
      <label v-if="salaryBodyReviewRequired" class="salary-body-review"><input v-model="salaryBodyReviewed" type="checkbox" />已核对正文中的薪资安排与本次填写一致</label>
      </div>
      </div>
    </div>
  </div>

  <div v-if="showTemplateManager" class="overlay" role="presentation" @click.self="showTemplateManager = false">
    <div class="dialog offer-template-dialog" role="dialog" aria-modal="true" aria-labelledby="offer-template-title">
      <div class="dialog-heading"><h3 id="offer-template-title">Offer 模板</h3><button class="btn btn-ghost btn-compact" type="button" @click="resetTemplateForm">新建模板</button></div>
      <div class="template-manager-grid">
        <div class="template-list" aria-label="Offer 模板列表">
          <div v-if="!offerTemplates.length" class="list-muted">暂无模板，可上传 .md、HTML 或文本文件后保存。</div>
          <article v-for="template in offerTemplates" :key="template.id" class="template-list-item" :class="{ selected: templateForm.id === template.id }">
            <button class="template-item-main" type="button" @click="editTemplate(template)">
              <strong>{{ template.name }}</strong><small>{{ template.filename }}</small>
            </button>
            <div class="template-item-meta"><span>{{ template.isActive ? '已启用' : '已停用' }}</span><span v-if="template.isDefault">默认</span></div>
            <div class="template-item-actions">
              <button class="btn btn-ghost btn-compact" type="button" @click="toggleTemplate(template)">{{ template.isActive ? '停用' : '启用' }}</button>
              <button class="btn btn-ghost btn-compact" type="button" :disabled="template.isDefault" @click="setDefaultTemplate(template)">设默认</button>
              <button class="btn btn-danger btn-compact" type="button" @click="removeTemplate(template)">删除</button>
            </div>
          </article>
        </div>
        <div class="template-editor">
          <div class="form-grid">
            <div class="form-field"><label>模板名称</label><input v-model="templateForm.name" maxlength="200" /></div>
            <div class="form-field"><label>模板文件</label><input ref="templateUploadInput" type="file" accept=".md,.html,.htm,.txt,text/markdown,text/html,text/plain" @change="onTemplateFileChange" /></div>
            <div class="form-field"><label>文件名</label><input v-model="templateForm.filename" placeholder="offer.html" /></div>
            <div class="template-checks">
              <label><input v-model="templateForm.isActive" type="checkbox" /> 启用</label>
              <label><input v-model="templateForm.isDefault" type="checkbox" :disabled="!templateForm.isActive" /> 设为默认</label>
            </div>
            <div class="form-field" style="grid-column:1 / -1"><label>模板内容</label><RichTextEditor v-model="templateForm.content" :variables="templateVariables" :min-height="300" /></div>
          </div>
          <details class="template-preview"><summary>预览</summary><div class="template-preview-surface"><RichTextEditor :model-value="templatePreviewHtml" :editable="false" :show-toolbar="false" :min-height="0" /></div></details>
          <div class="dialog-buttons"><button class="btn btn-ghost" type="button" :disabled="savingTemplate" @click="showTemplateManager = false">关闭</button><button class="btn btn-primary" type="button" :disabled="savingTemplate" @click="saveTemplate">{{ savingTemplate ? '保存中...' : '保存模板' }}</button></div>
        </div>
      </div>
    </div>
  </div>


</template>

<style scoped>
.offer-form-heading{grid-column:1 / -1;margin:12px 0 0;padding-bottom:8px;border-bottom:1px solid var(--border,#dbe3ef);font-size:14px}
.salary-body-review{grid-column:1 / -1;display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:1.6;color:#a34c15}
.salary-body-review input{width:16px;height:16px;flex:none;margin-top:3px}
.offer-create-dialog {
  display: flex;
  flex-direction: column;
  max-width: 860px;
  max-height: min(86vh, 760px);
  overflow: hidden;
}
.offer-create-header {
  position: relative;
  z-index: 1;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #e6ece7;
}
.offer-create-header h3 { margin: 0; }
.offer-create-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }
.offer-create-body {
  min-height: 0;
  overflow-y: auto;
  padding: 2px 4px 2px 0;
}
.offer-queue { margin: 0 0 18px; border: 1px solid #dbe6df; border-radius: 8px; background: #fff; overflow: hidden; }
.offer-queue-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border-bottom: 1px solid #e8eeea; background: #f6faf7; }
.offer-queue-head h2 { margin: 0; font-size: 16px; color: #243b30; }
.offer-queue-head p { margin: 4px 0 0; color: #65766d; font-size: 13px; }
.offer-queue-head > span { color: #346649; font-size: 13px; font-weight: 600; white-space: nowrap; }
.offer-queue-table-wrap { overflow-x: auto; }
.offer-queue-table { width: 100%; min-width: 560px; border-collapse: collapse; font-size: 13px; }
.offer-queue-table th, .offer-queue-table td { padding: 12px 16px; border-bottom: 1px solid #eef2ef; text-align: left; }
.offer-queue-table th { color: #64766c; background: #fbfcfb; font-weight: 600; }
.offer-queue-table tbody tr:last-child td { border-bottom: 0; }
.btn-compact { min-height: 30px; padding: 5px 9px; font-size: 12px; }
.template-select-row { display: flex; align-items: center; gap: 8px; }
.template-select-row select { min-width: 0; flex: 1; }
.offer-materials-field { border: 1px solid #d8e3dc; border-radius: 7px; padding: 0; background: #fbfdfb; }
.offer-materials-field > summary { min-height: 38px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 11px; color: #31463a; cursor: pointer; font-size: 12px; }
.offer-materials-field[open] > summary { border-bottom: 1px solid #e4ebe6; }
.material-count { color: #66786d; font-size: 12px; }
.material-options { display: grid; gap: 9px; padding: 11px; }
.material-options > label { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; color: #334155; font-size: 13px; }
.material-options input[type="checkbox"] { width: 15px; height: 15px; margin: 0; }
.material-bank-input, .material-custom-input { flex: 1 1 190px; min-width: 160px; max-width: 320px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 6px 8px; }
.offer-template-dialog { width: min(1080px, calc(100vw - 32px)); max-width: none; max-height: min(88vh, 850px); overflow: auto; }
.dialog-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dialog-heading h3 { margin: 0; }
.template-manager-grid { display: grid; grid-template-columns: minmax(220px, .7fr) minmax(0, 1.3fr); gap: 20px; margin-top: 16px; }
.template-list { border-right: 1px solid #e6ece7; padding-right: 16px; }
.template-list-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 10px 0; border-bottom: 1px solid #edf1ee; }
.template-list-item.selected { background: #f2f8f3; }
.template-item-main { min-width: 0; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.template-item-main strong, .template-item-main small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.template-item-main small, .template-item-meta { color: #708077; font-size: 12px; }
.template-item-meta { display: flex; gap: 6px; align-items: start; }
.template-item-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px; }
.template-editor { min-width: 0; }
.template-checks { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding-top: 26px; font-size: 13px; }
.template-checks label { display: inline-flex; align-items: center; gap: 6px; }
.template-preview { margin-top: 12px; }
.template-preview summary { cursor: pointer; color: #4b6254; font-size: 13px; }
.template-preview-surface { max-height: 240px; margin-top: 8px; overflow: auto; padding: 12px; border: 1px solid #e1e8e2; background: #fafcfb; }
@media (max-width: 760px) { .template-manager-grid { grid-template-columns: 1fr; }.template-list { border-right: 0; border-bottom: 1px solid #e6ece7; padding: 0 0 12px; }.template-checks { padding-top: 0; }.template-select-row { align-items: stretch; flex-direction: column; }.offer-template-dialog { width: min(100vw - 20px, 1080px); }.material-bank-input, .material-custom-input { flex-basis: 100%; max-width: none; width: 100%; } }
@media (max-width: 520px) { .offer-create-header { align-items: flex-start; flex-direction: column; gap: 10px; }.offer-create-actions { align-self: flex-end; } }
</style>




