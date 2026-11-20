<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Plus, RefreshCw, Save, X } from '@lucide/vue'
import {
  actionOnboarding,
  createOnboardingMaterial,
  createOnboardingTask,
  getOnboarding,
  listOnboardingMaterials,
  listOnboardingTasks,
  updateOnboarding,
  updateOnboardingMaterial,
  updateOnboardingTask,
  ONBOARDING_CANCELLATION_REASONS,
  ONBOARDING_MATERIAL_STATUS_LABEL,
  ONBOARDING_NO_SHOW_REASONS,
  ONBOARDING_REASON_LABEL,
  ONBOARDING_STATUS_LABEL,
  ONBOARDING_TASK_CATEGORY_LABEL,
  ONBOARDING_TASK_STATUS_LABEL,
  type ApiOnboarding,
  type ApiOnboardingMaterial,
  type ApiOnboardingTask,
  type ApiOnboardingWorkbenchItem,
  type OnboardingAction,
  type OnboardingCancellationReason,
  type OnboardingMaterialStatus,
  type OnboardingNoShowReason,
  type OnboardingTaskCategory,
  type OnboardingTaskOwnerRole,
  type OnboardingTaskStatus,
} from '../api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { loadWorkflowEvents, type WorkflowEvent } from '../../../shared/api/workflow-events'
import ApiFeedback from '../../../shared/components/workflow/ApiFeedback.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import WorkflowEventTable from '../../../shared/components/workflow/WorkflowEventTable.vue'
import ApplicationResumeButton from '../../candidates/components/ApplicationResumeButton.vue'
import CalendarDatePicker from '../../../shared/components/CalendarDatePicker.vue'
import { formatBusinessDateTime as formatDateTime } from '../../../shared/utils/date-time'

type DetailTab = 'overview' | 'schedule' | 'tasks' | 'materials' | 'audit'
type ReasonAction = 'cancel' | 'no_show'

interface TaskDraft {
  status: OnboardingTaskStatus
  isRequired: boolean
  ownerRole: OnboardingTaskOwnerRole
  ownerName: string
  dueDate: string
  blockedReason: string
  notes: string
}

interface MaterialDraft {
  status: OnboardingMaterialStatus
  isRequired: boolean
  notes: string
}

interface ScheduleForm {
  plannedStartDate: string
  plannedStartTime: string
  reportingMode: NonNullable<ApiOnboarding['reportingMode']> | ''
  reportingLocation: string
  reportingContactName: string
  reportingContactPhone: string
  workCity: string
  officeLocation: string
  hrOwnerName: string
  hiringManagerName: string
  riskNotes: string
  notes: string
}

const props = defineProps<{ item: ApiOnboardingWorkbenchItem }>()
const emit = defineEmits<{ close: []; updated: [message: string] }>()

const record = ref<ApiOnboarding>({ ...props.item.onboarding })
const tasks = ref<ApiOnboardingTask[]>([...props.item.tasks])
const materials = ref<ApiOnboardingMaterial[]>([...props.item.materials])
const taskDrafts = ref<Record<string, TaskDraft>>({})
const materialDrafts = ref<Record<string, MaterialDraft>>({})
const activeTab = ref<DetailTab>('overview')
const feedback = ref('')
const error = ref('')
const busy = ref('')
const auditEvents = ref<WorkflowEvent[]>([])
const auditLoaded = ref(false)
const auditLoading = ref(false)
const reasonAction = ref<ReasonAction | null>(null)
const reasonCode = ref<OnboardingCancellationReason | OnboardingNoShowReason | ''>('')
const reasonNotes = ref('')
const scheduleForm = ref(scheduleFormFrom(record.value))
const newTask = ref({
  title: '',
  category: 'hr' as OnboardingTaskCategory,
  isRequired: true,
  ownerRole: 'hr_admin' as OnboardingTaskOwnerRole,
  ownerName: '',
  dueDate: '',
  notes: '',
})
const newMaterial = ref({ code: '', label: '', isRequired: true, notes: '' })

const editable = computed(() => ['pending', 'preparing', 'scheduled', 'completed'].includes(record.value.status))
const cancellable = computed(() => ['pending', 'preparing', 'scheduled'].includes(record.value.status))
const completedTaskCount = computed(() => tasks.value.filter((task) => ['completed', 'not_required'].includes(task.status)).length)
const requiredTasksRemaining = computed(() => tasks.value.filter((task) => task.isRequired && !['completed', 'not_required'].includes(task.status)).length)
const requiredMaterialsRemaining = computed(() => materials.value.filter((material) => material.isRequired && !['verified', 'waived'].includes(material.status)).length)
const readiness = computed(() => {
  const required = [...tasks.value.filter((task) => task.isRequired), ...materials.value.filter((material) => material.isRequired)]
  if (!required.length) return 100
  const done = tasks.value.filter((task) => task.isRequired && ['completed', 'not_required'].includes(task.status)).length
    + materials.value.filter((material) => material.isRequired && ['verified', 'waived'].includes(material.status)).length
  return Math.round((done / required.length) * 100)
})
const nextDueDate = computed(() => tasks.value
  .filter((task) => task.dueDate && !['completed', 'not_required'].includes(task.status))
  .map((task) => task.dueDate!)
  .sort()[0] ?? '')
const riskReasons = computed(() => {
  const reasons = props.item.highRiskReasons.filter((reason) => !reason.includes('系统集成') && !reason.includes('提醒'))
  const overdue = tasks.value.filter((task) => task.dueDate && task.dueDate < today() && !['completed', 'not_required'].includes(task.status)).length
  if (overdue) reasons.push(`${overdue} 项任务已逾期`)
  return [...new Set(reasons)]
})
const tabs = computed<Array<{ key: DetailTab; label: string; count?: number }>>(() => [
  { key: 'overview', label: '概览' },
  { key: 'schedule', label: '报到' },
  { key: 'tasks', label: '任务', count: tasks.value.length },
  { key: 'materials', label: '材料', count: materials.value.length },
  { key: 'audit', label: '操作记录' },
])
const reasonOptions = computed(() => reasonAction.value === 'cancel' ? ONBOARDING_CANCELLATION_REASONS : reasonAction.value === 'no_show' ? ONBOARDING_NO_SHOW_REASONS : [])
const canSubmitReason = computed(() => Boolean(reasonCode.value && (reasonCode.value !== 'other' || reasonNotes.value.trim())))

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function scheduleFormFrom(value: ApiOnboarding): ScheduleForm {
  return {
    plannedStartDate: value.plannedStartDate?.slice(0, 10) ?? '',
    plannedStartTime: value.plannedStartTime?.slice(0, 5) ?? '',
    reportingMode: value.reportingMode ?? '',
    reportingLocation: value.reportingLocation ?? '',
    reportingContactName: value.reportingContactName ?? '',
    reportingContactPhone: value.reportingContactPhone ?? '',
    workCity: value.workCity ?? '',
    officeLocation: value.officeLocation ?? '',
    hrOwnerName: value.hrOwnerName ?? '',
    hiringManagerName: value.hiringManagerName ?? '',
    riskNotes: value.riskNotes ?? '',
    notes: value.notes ?? '',
  }
}

const TASK_OWNER_ROLE_LABEL: Record<OnboardingTaskOwnerRole, string> = {
  recruiter: '招聘 HR',
  hiring_manager: '用人经理',
  admin: '行政',
  hr_admin: 'HR 管理员',
  candidate: '候选人',
}

const REPORTING_MODE_LABEL: Record<NonNullable<ApiOnboarding['reportingMode']>, string> = {
  onsite: '现场报到',
  remote: '远程报到',
  hybrid: '混合报到',
}

const MATERIAL_LABELS: Record<string, string> = {
  identity: '身份证明',
  id_card: '身份证',
  education: '学历与学位证明',
  graduation_certificate: '毕业证书、学位证书',
  separation: '离职证明',
  previous_employment_release: '上家公司劳动合同解除证明或者离职证明',
  previous_employment_payroll: '上家单位一年工资流水',
  photo: '一寸照片一张',
  medical_report: '体检报告',
  bank_account: '银行卡信息',
  bank_card: '工资卡',
}

function materialDisplayLabel(material: ApiOnboardingMaterial): string {
  const label = material.label?.trim()
  if (label && !/^[a-z0-9_:-]+$/iu.test(label)) return label
  const [code, ...detailParts] = (material.code || label || '').split(':')
  const detail = detailParts.join(':').trim()
  if (code === 'bank_card' && detail) return `${detail}工资卡`
  return MATERIAL_LABELS[code] || '入职材料'
}

function materialDisplayName(material: ApiOnboardingMaterial): string {
  const label = material.label?.trim()
  return label && !/^[a-z0-9_:-]+$/iu.test(label) ? label : materialDisplayLabel(material)
}

function hydrationDrafts() {
  taskDrafts.value = Object.fromEntries(tasks.value.map((task) => [task.id, {
    status: task.status,
    isRequired: task.isRequired,
    ownerRole: task.ownerRole ?? 'hr_admin',
    ownerName: task.ownerName ?? '',
    dueDate: task.dueDate ?? '',
    blockedReason: task.blockedReason ?? '',
    notes: task.notes ?? '',
  }]))
  materialDrafts.value = Object.fromEntries(materials.value.map((material) => [material.id, {
    status: material.status,
    isRequired: material.isRequired,
    notes: material.notes ?? '',
  }]))
}

function hydrate(value: ApiOnboardingWorkbenchItem) {
  record.value = value.onboarding
  tasks.value = value.tasks
  materials.value = value.materials
  scheduleForm.value = scheduleFormFrom(value.onboarding)
  hydrationDrafts()
}

function clearNotice() {
  error.value = ''
  feedback.value = ''
}

function failure(cause: unknown, fallback: string) {
  error.value = describeApiFailure(cause, fallback).message
  feedback.value = ''
}

function success(message: string) {
  feedback.value = message
  error.value = ''
}

function close() {
  if (!busy.value) emit('close')
}

function notifyUpdated(message: string) {
  success(message)
  emit('updated', message)
}

async function saveSchedule(showNotice = true): Promise<boolean> {
  if (!editable.value || busy.value) return false
  busy.value = 'schedule-save'
  clearNotice()
  try {
    const form = scheduleForm.value
    record.value = await updateOnboarding(record.value.id, {
      plannedStartDate: form.plannedStartDate || null,
      plannedStartTime: form.plannedStartTime || null,
      reportingMode: form.reportingMode || null,
      reportingLocation: form.reportingLocation,
      reportingContactName: form.reportingContactName,
      reportingContactPhone: form.reportingContactPhone,
      workCity: form.workCity,
      officeLocation: form.officeLocation,
      hrOwnerName: form.hrOwnerName,
      hiringManagerName: form.hiringManagerName,
      riskNotes: form.riskNotes,
      notes: form.notes,
    })
    scheduleForm.value = scheduleFormFrom(record.value)
    if (showNotice) notifyUpdated('报到安排已保存')
    return true
  } catch (cause) {
    failure(cause, '保存报到安排失败')
    return false
  } finally {
    busy.value = ''
  }
}

async function performAction(action: OnboardingAction, payload: Parameters<typeof actionOnboarding>[2] = {}) {
  if (busy.value) return
  if (action === 'complete' && (requiredTasksRemaining.value || requiredMaterialsRemaining.value)) {
    error.value = `仍有 ${requiredTasksRemaining.value} 项必选任务、${requiredMaterialsRemaining.value} 项必选材料未完成`
    return
  }
  busy.value = action
  clearNotice()
  try {
    record.value = await actionOnboarding(record.value.id, action, payload)
    scheduleForm.value = scheduleFormFrom(record.value)
    notifyUpdated(`${ONBOARDING_STATUS_LABEL[record.value.status]}，状态已更新`)
  } catch (cause) {
    failure(cause, '更新入职状态失败')
  } finally {
    busy.value = ''
  }
}

function openReason(action: ReasonAction) {
  reasonAction.value = action
  reasonCode.value = ''
  reasonNotes.value = ''
  error.value = ''
}

async function submitReason() {
  const action = reasonAction.value
  const code = reasonCode.value
  if (!action || !code || !canSubmitReason.value) return
  await performAction(action, { reasonCode: code, notes: reasonNotes.value.trim() || undefined })
  if (!error.value) reasonAction.value = null
}

async function confirmSchedule() {
  if (await saveSchedule(false)) await performAction('schedule')
}

async function saveTask(task: ApiOnboardingTask) {
  const draft = taskDrafts.value[task.id]
  if (!draft || busy.value) return
  if (draft.status === 'blocked' && !draft.blockedReason.trim()) {
    error.value = `任务「${task.title}」阻塞时必须填写原因`
    return
  }
  busy.value = `task-${task.id}`
  clearNotice()
  try {
    const updated = await updateOnboardingTask(record.value.id, task.id, {
      status: draft.status,
      isRequired: draft.isRequired,
      ownerRole: draft.ownerRole,
      ownerName: draft.ownerName.trim(),
      dueDate: draft.dueDate,
      blockedReason: draft.status === 'blocked' ? draft.blockedReason.trim() : '',
      notes: draft.notes,
    })
    tasks.value = tasks.value.map((item) => item.id === task.id ? updated : item)
    taskDrafts.value[task.id] = { status: updated.status, isRequired: updated.isRequired, ownerRole: updated.ownerRole ?? 'hr_admin', ownerName: updated.ownerName ?? '', dueDate: updated.dueDate ?? '', blockedReason: updated.blockedReason ?? '', notes: updated.notes ?? '' }
    notifyUpdated(`任务「${task.title}」已更新`)
  } catch (cause) {
    failure(cause, '更新入职任务失败')
  } finally {
    busy.value = ''
  }
}

async function addTask() {
  if (!newTask.value.title.trim() || busy.value) return
  busy.value = 'task-create'
  clearNotice()
  try {
    const created = await createOnboardingTask(record.value.id, {
      title: newTask.value.title.trim(),
      category: newTask.value.category,
      isRequired: newTask.value.isRequired,
      ownerRole: newTask.value.ownerRole,
      ...(newTask.value.ownerName.trim() ? { ownerName: newTask.value.ownerName.trim() } : {}),
      ...(newTask.value.dueDate ? { dueDate: newTask.value.dueDate } : {}),
      ...(newTask.value.notes.trim() ? { notes: newTask.value.notes.trim() } : {}),
    })
    tasks.value.push(created)
    taskDrafts.value[created.id] = { status: created.status, isRequired: created.isRequired, ownerRole: created.ownerRole ?? 'hr_admin', ownerName: created.ownerName ?? '', dueDate: created.dueDate ?? '', blockedReason: '', notes: created.notes ?? '' }
    newTask.value = { title: '', category: 'hr', isRequired: true, ownerRole: 'hr_admin', ownerName: '', dueDate: '', notes: '' }
    notifyUpdated('入职任务已添加')
  } catch (cause) {
    failure(cause, '添加入职任务失败')
  } finally {
    busy.value = ''
  }
}

async function saveMaterial(material: ApiOnboardingMaterial) {
  const draft = materialDrafts.value[material.id]
  if (!draft || busy.value) return
  busy.value = `material-${material.id}`
  clearNotice()
  try {
    const updated = await updateOnboardingMaterial(record.value.id, material.id, { status: draft.status, isRequired: draft.isRequired, notes: draft.notes })
    materials.value = materials.value.map((item) => item.id === material.id ? updated : item)
    materialDrafts.value[material.id] = { status: updated.status, isRequired: updated.isRequired, notes: updated.notes ?? '' }
    notifyUpdated(`材料「${materialDisplayName(material)}」已更新`)
  } catch (cause) {
    failure(cause, '更新入职材料失败')
  } finally {
    busy.value = ''
  }
}

async function addMaterial() {
  if (!newMaterial.value.code.trim() || !newMaterial.value.label.trim() || busy.value) return
  busy.value = 'material-create'
  clearNotice()
  try {
    const created = await createOnboardingMaterial(record.value.id, {
      code: newMaterial.value.code.trim(),
      label: newMaterial.value.label.trim(),
      isRequired: newMaterial.value.isRequired,
      ...(newMaterial.value.notes.trim() ? { notes: newMaterial.value.notes.trim() } : {}),
    })
    materials.value.push(created)
    materialDrafts.value[created.id] = { status: created.status, isRequired: created.isRequired, notes: created.notes ?? '' }
    newMaterial.value = { code: '', label: '', isRequired: true, notes: '' }
    notifyUpdated('入职材料已添加')
  } catch (cause) {
    failure(cause, '添加入职材料失败')
  } finally {
    busy.value = ''
  }
}

async function loadAudit(force = false) {
  if (auditLoading.value || (auditLoaded.value && !force)) return
  auditLoading.value = true
  try {
    auditEvents.value = await loadWorkflowEvents('onboarding', 100).then((rows) => rows.filter((event) => event.subjectId === record.value.id))
    auditLoaded.value = true
  } catch {
    auditEvents.value = []
  } finally {
    auditLoading.value = false
  }
}

watch(activeTab, (tab) => {
  if (tab === 'audit') void loadAudit()
})

watch(() => props.item.onboarding.id, () => hydrate(props.item))
hydrationDrafts()
</script>

<template>
  <div class="overlay workbench-overlay" role="presentation" @click.self="close">
    <section class="dialog onboarding-workbench" role="dialog" aria-modal="true" aria-labelledby="onboarding-workbench-title">
      <header class="workbench-header">
        <div class="identity">
          <div class="identity-title">
            <h2 id="onboarding-workbench-title">{{ item.candidateName }}</h2>
            <StatusTag :status="record.status" />
          </div>
          <p>{{ item.jobTitle }} · {{ item.department || '部门未补充' }} · {{ item.offerCode }}</p>
          <ApplicationResumeButton :application-id="record.applicationId" />
        </div>
        <div class="header-actions">
          <button v-if="record.status === 'pending'" class="btn btn-primary" type="button" :disabled="!!busy" @click="performAction('prepare')">开始准备</button>
          <button v-if="record.status === 'preparing'" class="btn btn-primary" type="button" :disabled="!!busy" @click="confirmSchedule">保存并确认报到</button>
          <button v-if="record.status === 'scheduled'" class="btn btn-primary" type="button" :disabled="!!busy" @click="performAction('complete')">确认已报到</button>
          <button v-if="record.status === 'scheduled'" class="btn btn-danger" type="button" :disabled="!!busy" @click="openReason('no_show')">登记未报到</button>
          <button v-if="cancellable" class="btn btn-danger" type="button" :disabled="!!busy" @click="openReason('cancel')">取消入职</button>
          <button class="close-button" type="button" title="关闭入职工作台" aria-label="关闭入职工作台" :disabled="!!busy" @click="close"><X :size="19" /></button>
        </div>
      </header>

      <div class="readiness-band">
        <div class="readiness-score"><strong>{{ readiness }}%</strong><span>入职就绪度</span></div>
        <div class="readiness-detail">
          <div class="readiness-track" aria-hidden="true"><span :style="{ width: `${readiness}%` }" /></div>
          <p>{{ requiredTasksRemaining }} 项必选任务待完成 · {{ requiredMaterialsRemaining }} 项必选材料待核验 · 下一截止 {{ nextDueDate || '未设置' }}</p>
        </div>
        <div class="risk-summary" :class="{ risky: riskReasons.length }"><strong>{{ riskReasons.length ? `${riskReasons.length} 项风险` : '暂无高风险' }}</strong><span>{{ riskReasons[0] || '关键交接信息完整' }}</span></div>
      </div>

      <ApiFeedback v-if="feedback" tone="success" dismissible :message="feedback" @dismiss="feedback = ''" />
      <ApiFeedback v-if="error" tone="error" dismissible :message="error" @dismiss="error = ''" />

      <nav class="workbench-tabs" aria-label="入职工作台模块">
        <button v-for="tab in tabs" :key="tab.key" type="button" :class="{ active: activeTab === tab.key }" @click="activeTab = tab.key">
          {{ tab.label }}<span v-if="tab.count !== undefined">{{ tab.count }}</span>
        </button>
      </nav>

      <div class="workbench-body">
        <div v-if="record.status === 'completed'" class="terminal-note completed-note">该员工已完成报到，仍可继续补录报到信息、任务和材料，变更会进入操作记录。</div>
        <div v-else-if="!editable" class="terminal-note">当前记录已进入终态，以下内容仅供查看，不允许继续编辑。</div>

        <section v-if="activeTab === 'overview'" class="tab-content" aria-label="入职概览">
          <div class="section-heading">
            <div><h3>入职交接概览</h3><p>集中核对候选人、岗位、报到安排和关键风险。</p></div>
            <span class="section-meta">就绪 {{ readiness }}%</span>
          </div>
          <div class="overview-grid">
            <section class="info-section">
              <h4>归档信息</h4>
              <dl class="detail-list">
                <div><dt>Offer</dt><dd>{{ item.offerCode || '未记录' }}</dd></div>
                <div><dt>应聘记录</dt><dd>{{ record.applicationId }}</dd></div>
                <div><dt>岗位</dt><dd>{{ item.jobTitle || '未记录' }}</dd></div>
                <div><dt>用人部门</dt><dd>{{ item.department || '未记录' }}</dd></div>
                <div><dt>归档时间</dt><dd>{{ formatDateTime(record.archivedAt || record.createdAt) }}</dd></div>
                <div><dt>当前状态</dt><dd>{{ ONBOARDING_STATUS_LABEL[record.status] }}</dd></div>
              </dl>
            </section>
            <section class="info-section">
              <h4>报到安排</h4>
              <dl class="detail-list">
                <div><dt>计划日期</dt><dd>{{ record.plannedStartDate || '未安排' }}</dd></div>
                <div><dt>计划时间</dt><dd>{{ record.plannedStartTime || '未安排' }}</dd></div>
                <div><dt>报到方式</dt><dd>{{ record.reportingMode ? REPORTING_MODE_LABEL[record.reportingMode] : '未安排' }}</dd></div>
                <div><dt>报到地点</dt><dd>{{ record.reportingLocation || record.officeLocation || '未安排' }}</dd></div>
                <div><dt>工作城市</dt><dd>{{ record.workCity || '未记录' }}</dd></div>
                <div><dt>报到联系人</dt><dd>{{ record.reportingContactName || '未指定' }}<span v-if="record.reportingContactPhone"> · {{ record.reportingContactPhone }}</span></dd></div>
              </dl>
            </section>
            <section class="info-section">
              <h4>责任交接</h4>
              <dl class="detail-list">
                <div><dt>HR 负责人</dt><dd>{{ record.hrOwnerName || '未指定' }}</dd></div>
                <div><dt>用人经理</dt><dd>{{ record.hiringManagerName || '未指定' }}</dd></div>
                <div><dt>任务进度</dt><dd>{{ completedTaskCount }} / {{ tasks.length }} 项已完成</dd></div>
                <div><dt>材料进度</dt><dd>{{ materials.filter((material) => ['verified', 'waived'].includes(material.status)).length }} / {{ materials.length }} 项已核验</dd></div>
                <div><dt>必选缺口</dt><dd>{{ requiredTasksRemaining }} 项任务 · {{ requiredMaterialsRemaining }} 项材料</dd></div>
                <div><dt>下一截止</dt><dd>{{ nextDueDate || '未设置' }}</dd></div>
              </dl>
            </section>
          </div>

          <div class="overview-lower">
            <section class="info-section">
              <h4>风险与阻塞</h4>
              <ul v-if="riskReasons.length" class="reason-list">
                <li v-for="reason in riskReasons" :key="reason">{{ reason }}</li>
              </ul>
              <p v-else class="empty-copy">当前未识别到逾期或阻塞风险。</p>
              <p v-if="record.riskNotes" class="long-copy"><strong>风险备注：</strong>{{ record.riskNotes }}</p>
            </section>
            <section v-if="record.status === 'cancelled' || record.status === 'no_show'" class="info-section terminal-detail">
              <h4>{{ record.status === 'cancelled' ? '取消归档' : '未报到归档' }}</h4>
              <dl class="detail-list">
                <div><dt>原因</dt><dd>{{ ONBOARDING_REASON_LABEL[(record.cancellationReasonCode || record.noShowReasonCode) || ''] || '未记录' }}</dd></div>
                <div><dt>登记时间</dt><dd>{{ formatDateTime(record.cancelledAt || record.noShowAt) }}</dd></div>
              </dl>
              <p class="long-copy">{{ record.cancellationNotes || record.noShowNotes || '未填写补充说明。' }}</p>
            </section>
            <section class="info-section">
              <h4>内部备注</h4>
              <p class="long-copy">{{ record.notes || '暂无内部备注。' }}</p>
            </section>
          </div>
        </section>

        <section v-else-if="activeTab === 'schedule'" class="tab-content" aria-label="报到安排">
          <div class="section-heading">
            <div><h3>报到安排</h3><p>日期、方式和联系人会作为报到安排的共同基准。</p></div>
            <span class="section-meta">{{ ONBOARDING_STATUS_LABEL[record.status] }}</span>
          </div>
          <div class="form-grid workbench-form-grid">
            <label class="field"><span>计划日期</span><input v-model="scheduleForm.plannedStartDate" type="date" :disabled="!editable"></label>
            <label class="field"><span>计划时间</span><input v-model="scheduleForm.plannedStartTime" type="time" :disabled="!editable"></label>
            <label class="field"><span>报到方式</span>
              <select v-model="scheduleForm.reportingMode" :disabled="!editable">
                <option value="">未安排</option>
                <option v-for="(label, value) in REPORTING_MODE_LABEL" :key="value" :value="value">{{ label }}</option>
              </select>
            </label>
            <label class="field field-wide"><span>报到地点 / 线上链接</span><input v-model="scheduleForm.reportingLocation" type="text" placeholder="办公地点、楼层或视频会议链接" :disabled="!editable"></label>
            <label class="field"><span>报到联系人</span><input v-model="scheduleForm.reportingContactName" type="text" placeholder="现场接待人" :disabled="!editable"></label>
            <label class="field"><span>联系人电话</span><input v-model="scheduleForm.reportingContactPhone" type="tel" placeholder="候选人报到当日联系方式" :disabled="!editable"></label>
            <label class="field"><span>工作城市</span><input v-model="scheduleForm.workCity" type="text" :disabled="!editable"></label>
            <label class="field"><span>办公地点</span><input v-model="scheduleForm.officeLocation" type="text" :disabled="!editable"></label>
            <label class="field"><span>HR 负责人</span><input v-model="scheduleForm.hrOwnerName" type="text" :disabled="!editable"></label>
            <label class="field"><span>用人经理</span><input v-model="scheduleForm.hiringManagerName" type="text" :disabled="!editable"></label>
            <label class="field field-wide"><span>风险提示</span><textarea v-model="scheduleForm.riskNotes" rows="2" placeholder="记录交接、通勤、材料或到岗时间风险" :disabled="!editable"></textarea></label>
            <label class="field field-wide"><span>内部备注</span><textarea v-model="scheduleForm.notes" rows="3" placeholder="仅内部协作可见的补充说明" :disabled="!editable"></textarea></label>
          </div>
          <div v-if="editable" class="section-actions">
            <button class="btn btn-ghost" type="button" :disabled="!!busy" @click="saveSchedule()"><Save :size="15" />保存安排</button>
            <button v-if="record.status === 'preparing'" class="btn btn-primary" type="button" :disabled="!!busy" @click="confirmSchedule"><Save :size="15" />保存并确认报到</button>
          </div>
        </section>

        <section v-else-if="activeTab === 'tasks'" class="tab-content" aria-label="入职任务">
          <div class="section-heading">
            <div><h3>跨部门任务</h3><p>按归属角色推进账号、设备、行政、培训和用人部门交接。</p></div>
            <span class="section-meta">{{ completedTaskCount }} / {{ tasks.length }} 已完成</span>
          </div>
          <div v-if="tasks.length" class="item-list">
            <article v-for="task in tasks" :key="task.id" class="line-item">
              <header class="line-item-head">
                <div><strong>{{ task.title }}</strong><span>{{ ONBOARDING_TASK_CATEGORY_LABEL[task.category] }} · {{ task.isRequired ? '必选' : '可选' }}</span></div>
                <span class="state-pill" :class="`state-${task.status}`">{{ ONBOARDING_TASK_STATUS_LABEL[task.status] }}</span>
              </header>
              <div class="item-grid">
                <label class="field"><span>状态</span>
                  <select v-model="taskDrafts[task.id]!.status" :disabled="!editable">
                    <option v-for="(label, value) in ONBOARDING_TASK_STATUS_LABEL" :key="value" :value="value">{{ label }}</option>
                  </select>
                </label>
                <label class="field"><span>承接角色</span>
                  <select v-model="taskDrafts[task.id]!.ownerRole" :disabled="!editable">
                    <option v-for="(label, value) in TASK_OWNER_ROLE_LABEL" :key="value" :value="value">{{ label }}</option>
                  </select>
                </label>
                <label class="field"><span>负责人</span><input v-model="taskDrafts[task.id]!.ownerName" type="text" placeholder="姓名或团队" :disabled="!editable"></label>
                <div class="field"><span>截止日期</span><CalendarDatePicker v-model="taskDrafts[task.id]!.dueDate" :ariaLabel="task.title + '截止日期'" :disabled="!editable" /></div>
                <label class="check-field"><input v-model="taskDrafts[task.id]!.isRequired" type="checkbox" :disabled="!editable"><span>纳入入职就绪度</span></label>
                <label v-if="taskDrafts[task.id]!.status === 'blocked'" class="field field-wide"><span>阻塞原因</span><input v-model="taskDrafts[task.id]!.blockedReason" type="text" placeholder="必填，说明等待事项和责任方" :disabled="!editable"></label>
                <label class="field field-wide"><span>备注</span><textarea v-model="taskDrafts[task.id]!.notes" rows="2" :disabled="!editable"></textarea></label>
              </div>
              <div v-if="editable" class="item-actions"><button class="btn btn-ghost" type="button" :disabled="!!busy" @click="saveTask(task)"><Save :size="14" />保存任务</button></div>
            </article>
          </div>
          <p v-else class="empty-state">暂无入职任务。</p>

          <section v-if="editable" class="new-item-panel">
            <div class="subsection-title"><h4>新增任务</h4><span>用于补充标准模板之外的交接事项</span></div>
            <div class="item-grid">
              <label class="field field-wide"><span>任务名称</span><input v-model="newTask.title" type="text" placeholder="例如：配置业务系统数据权限"></label>
              <label class="field"><span>任务分类</span><select v-model="newTask.category"><option v-for="(label, value) in ONBOARDING_TASK_CATEGORY_LABEL" :key="value" :value="value">{{ label }}</option></select></label>
              <label class="field"><span>承接角色</span><select v-model="newTask.ownerRole"><option v-for="(label, value) in TASK_OWNER_ROLE_LABEL" :key="value" :value="value">{{ label }}</option></select></label>
              <label class="field"><span>负责人</span><input v-model="newTask.ownerName" type="text" placeholder="姓名或团队"></label>
              <div class="field"><span>截止日期</span><CalendarDatePicker v-model="newTask.dueDate" ariaLabel="新任务截止日期" /></div>
              <label class="check-field"><input v-model="newTask.isRequired" type="checkbox"><span>纳入入职就绪度</span></label>
              <label class="field field-wide"><span>备注</span><textarea v-model="newTask.notes" rows="2"></textarea></label>
            </div>
            <div class="section-actions"><button class="btn btn-primary" type="button" :disabled="!!busy || !newTask.title.trim()" @click="addTask"><Plus :size="15" />添加任务</button></div>
          </section>
        </section>

        <section v-else-if="activeTab === 'materials'" class="tab-content" aria-label="入职材料核验">
          <div class="section-heading">
            <div><h3>材料核验</h3><p>采集、核验和豁免动作会同步影响报到就绪度。</p></div>
            <span class="section-meta">{{ requiredMaterialsRemaining }} 项必选待核验</span>
          </div>
          <div v-if="materials.length" class="item-list">
            <article v-for="material in materials" :key="material.id" class="line-item material-item">
              <header class="line-item-head">
                <div><strong>{{ materialDisplayName(material) }}</strong><span>{{ material.isRequired ? '必选' : '可选' }}</span></div>
                <span class="state-pill" :class="`state-${material.status}`">{{ ONBOARDING_MATERIAL_STATUS_LABEL[material.status] }}</span>
              </header>
              <div class="item-grid material-grid">
                <label class="field"><span>核验状态</span>
                  <select v-model="materialDrafts[material.id]!.status" :disabled="!editable">
                    <option v-for="(label, value) in ONBOARDING_MATERIAL_STATUS_LABEL" :key="value" :value="value">{{ label }}</option>
                  </select>
                </label>
                <label class="check-field"><input v-model="materialDrafts[material.id]!.isRequired" type="checkbox" :disabled="!editable"><span>纳入入职就绪度</span></label>
                <label class="field field-wide"><span>核验备注</span><textarea v-model="materialDrafts[material.id]!.notes" rows="2" placeholder="记录缺失、补交或豁免依据" :disabled="!editable"></textarea></label>
              </div>
              <p class="record-time">采集 {{ formatDateTime(material.collectedAt) }} · 核验 {{ formatDateTime(material.verifiedAt) }}</p>
              <div v-if="editable" class="item-actions"><button class="btn btn-ghost" type="button" :disabled="!!busy" @click="saveMaterial(material)"><Save :size="14" />保存核验</button></div>
            </article>
          </div>
          <p v-else class="empty-state">暂无入职材料。</p>

          <section v-if="editable" class="new-item-panel">
            <div class="subsection-title"><h4>新增材料</h4><span>按实际岗位或地区要求补充个性化材料</span></div>
            <div class="item-grid">
              <label class="field"><span>材料编码</span><input v-model="newMaterial.code" type="text" placeholder="例如：degree_certificate"></label>
              <label class="field"><span>材料名称</span><input v-model="newMaterial.label" type="text" placeholder="例如：最高学历证书"></label>
              <label class="check-field"><input v-model="newMaterial.isRequired" type="checkbox"><span>纳入入职就绪度</span></label>
              <label class="field field-wide"><span>备注</span><textarea v-model="newMaterial.notes" rows="2"></textarea></label>
            </div>
            <div class="section-actions"><button class="btn btn-primary" type="button" :disabled="!!busy || !newMaterial.code.trim() || !newMaterial.label.trim()" @click="addMaterial"><Plus :size="15" />添加材料</button></div>
          </section>
        </section>

        <section v-else class="tab-content" aria-label="操作记录">
          <div class="section-heading">
            <div><h3>操作记录</h3><p>查看入职归档、任务、材料和状态流转的审计信息。</p></div>
            <button class="btn btn-ghost" type="button" :disabled="auditLoading" @click="loadAudit(true)"><RefreshCw :size="14" />刷新记录</button>
          </div>
          <WorkflowEventTable :events="auditEvents" :loading="auditLoading" />
        </section>
      </div>

      <footer class="workbench-footer">
        <span>最后更新 {{ record.updatedAt.slice(0, 19).replace('T', ' ') }}</span>
        <button class="btn btn-ghost" type="button" :disabled="!!busy" @click="close">关闭</button>
      </footer>

      <div v-if="reasonAction" class="overlay reason-overlay" role="presentation" @click.self="!busy && (reasonAction = null)">
        <section class="dialog reason-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-reason-title">
          <header class="reason-head">
            <div><h3 id="onboarding-reason-title">{{ reasonAction === 'cancel' ? '取消入职' : '登记未报到' }}</h3><p>请选择标准原因。该操作提交后记录将进入终态。</p></div>
            <button class="close-button" type="button" title="关闭" aria-label="关闭原因登记" :disabled="!!busy" @click="reasonAction = null"><X :size="18" /></button>
          </header>
          <div class="reason-body">
            <label v-for="option in reasonOptions" :key="option.value" class="reason-option" :class="{ selected: reasonCode === option.value }">
              <input v-model="reasonCode" type="radio" :value="option.value" :disabled="!!busy"><span>{{ option.label }}</span>
            </label>
            <label class="field"><span>{{ reasonCode === 'other' ? '补充说明（必填）' : '补充说明' }}</span><textarea v-model="reasonNotes" rows="3" placeholder="记录候选人反馈、沟通结果或内部处理依据" :disabled="!!busy"></textarea></label>
          </div>
          <footer class="reason-actions">
            <button class="btn btn-ghost" type="button" :disabled="!!busy" @click="reasonAction = null">返回</button>
            <button class="btn btn-danger" type="button" :disabled="!!busy || !canSubmitReason" @click="submitReason">{{ reasonAction === 'cancel' ? '确认取消入职' : '确认登记未报到' }}</button>
          </footer>
        </section>
      </div>
    </section>
  </div>
</template>

<style scoped>
.workbench-overlay { align-items: center; padding: 18px; }
.onboarding-workbench { width: min(1120px, calc(100vw - 36px)); max-width: 1120px; height: min(920px, calc(100vh - 36px)); height: min(920px, calc(100dvh - 36px)); max-height: calc(100vh - 36px); max-height: calc(100dvh - 36px); display: flex; flex-direction: column; overflow: hidden; padding: 0; border-radius: 14px; }
.onboarding-workbench > :not(.workbench-body) { flex-shrink: 0; }
.workbench-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 20px 22px 15px; border-bottom: 1px solid #e8eff4; }
.identity { min-width: 0; }
.identity-title { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.identity-title h2 { margin: 0; color: #18364f; font-size: 21px; }
.identity p { margin: 6px 0 9px; color: #7890a4; font-size: 12.5px; overflow-wrap: anywhere; }
.header-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 7px; }
.close-button { display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 1px solid #dfe9f0; border-radius: 9px; background: #fff; color: #7890a4; }
.close-button:hover { background: #f2f7fa; color: #27465f; }
.readiness-band { display: grid; grid-template-columns: 120px minmax(0, 1fr) minmax(160px, .55fr); align-items: center; gap: 18px; padding: 13px 22px; background: #f7fbfd; border-bottom: 1px solid #e8eff4; }
.readiness-score strong { display: block; color: #1e765d; font-size: 23px; }
.readiness-score span, .risk-summary span { display: block; margin-top: 3px; color: #8299ad; font-size: 11px; }
.readiness-track { height: 7px; overflow: hidden; border-radius: 999px; background: #e3ecef; }
.readiness-track span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #3cb38a, #65c9a6); }
.readiness-detail p { margin: 7px 0 0; color: #688094; font-size: 11.5px; line-height: 1.5; }
.risk-summary { min-width: 0; padding-left: 16px; border-left: 1px solid #dfe9f0; }
.risk-summary strong { display: block; color: #278666; font-size: 12px; }
.risk-summary.risky strong { color: #be123c; }
.risk-summary span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workbench-tabs { display: flex; min-height: 42px; gap: 2px; overflow-x: auto; padding: 0 18px; border-bottom: 1px solid #e8eff4; background: #fff; }
.workbench-tabs button { display: inline-flex; align-items: center; min-height: 42px; gap: 6px; flex: 0 0 auto; padding: 10px 13px 8px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: #71899d; font-size: 12.5px; }
.workbench-tabs button span { min-width: 18px; padding: 1px 5px; border-radius: 999px; background: #eef4f8; color: #7890a4; font-size: 10px; text-align: center; }
.workbench-tabs button.active { border-bottom-color: #397fe8; color: #276bc8; font-weight: 650; }
.workbench-tabs button.active span { background: #e8f2ff; color: #276bc8; }
.workbench-body { flex: 1 1 0; min-height: 0; overflow-y: auto; padding: 18px 22px 24px; background: #fff; }
.terminal-note { margin-bottom: 14px; padding: 9px 11px; border: 1px solid #dce7ee; border-radius: 8px; background: #f6f9fb; color: #6f8799; font-size: 12px; }
.tab-content { display: grid; gap: 16px; }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.section-heading h3 { margin: 0; color: #17364d; font-size: 16px; }
.section-heading p { margin: 5px 0 0; color: #7890a3; font-size: 12px; line-height: 1.55; }
.section-meta { flex: 0 0 auto; padding: 4px 8px; border-radius: 999px; background: #edf6f3; color: #26745c; font-size: 11px; }
.overview-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.overview-lower { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.info-section { min-width: 0; padding: 14px; border: 1px solid #e3ebf0; border-radius: 8px; background: #fff; }
.info-section h4, .subsection-title h4 { margin: 0 0 12px; color: #29485f; font-size: 12.5px; }
.detail-list { display: grid; gap: 9px; margin: 0; }
.detail-list > div { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 10px; }
.detail-list dt { color: #8297a8; font-size: 11.5px; }
.detail-list dd { margin: 0; color: #314f64; font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
.reason-list { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
.reason-list li { position: relative; padding: 7px 9px 7px 22px; border-radius: 6px; background: #fff6f7; color: #a52e48; font-size: 12px; }
.reason-list li::before { position: absolute; top: 8px; left: 9px; content: '!'; font-weight: 800; }
.empty-copy, .long-copy { margin: 0; color: #687f91; font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.long-copy { margin-top: 10px; }
.terminal-detail { border-color: #f1d7dc; background: #fffafb; }
.workbench-form-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.field { display: grid; gap: 5px; min-width: 0; color: #5c7488; font-size: 11.5px; }
.field > span { font-weight: 600; }
.field input, .field select, .field textarea { box-sizing: border-box; width: 100%; min-width: 0; padding: 8px 9px; border: 1px solid #cfdde6; border-radius: 7px; outline: none; background: #fff; color: #263f53; font: inherit; }
.field textarea { min-height: 58px; resize: vertical; line-height: 1.5; }
.field input::placeholder, .field textarea::placeholder { color: #9aabba; }
.field input:focus, .field select:focus, .field textarea:focus { border-color: #4c8bd8; box-shadow: 0 0 0 3px #e8f2ff; }
.field input:disabled, .field select:disabled, .field textarea:disabled { background: #f6f9fb; color: #5f7384; cursor: default; opacity: 1; }
.field-wide { grid-column: span 2; }
.section-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding-top: 12px; }
.section-actions .btn, .item-actions .btn { display: inline-flex; align-items: center; gap: 6px; }
.item-list { display: grid; gap: 10px; }
.line-item { padding: 13px; border: 1px solid #dfe9f0; border-radius: 8px; background: #fbfdfe; }
.line-item-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 11px; }
.line-item-head > div { display: grid; min-width: 0; gap: 4px; }
.line-item-head strong { color: #28485e; font-size: 13px; overflow-wrap: anywhere; }
.line-item-head span:not(.state-pill) { color: #8196a7; font-size: 10.5px; }
.state-pill { display: inline-flex; flex: 0 0 auto; align-items: center; min-height: 23px; padding: 2px 8px; border-radius: 999px; background: #edf2f6; color: #536d80; font-size: 10.5px; white-space: nowrap; }
.state-completed, .state-verified, .state-ready, .state-sent { background: #e8f6ef; color: #237153; }
.state-in_progress, .state-collected, .state-syncing, .state-scheduled { background: #edf4ff; color: #326da7; }
.state-blocked, .state-failed { background: #fff0f2; color: #b1334b; }
.state-not_required, .state-waived, .state-skipped, .state-not_configured { background: #f0f2f4; color: #71808c; }
.item-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: end; gap: 10px; }
.material-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.check-field { display: flex; align-items: center; gap: 7px; min-height: 34px; color: #536e82; font-size: 11.5px; }
.check-field input { width: 15px; height: 15px; margin: 0; accent-color: #3278cf; }
.item-actions { display: flex; justify-content: flex-end; padding-top: 9px; }
.record-time { margin: 9px 0 0; color: #8ba0af; font-size: 10.5px; }
.empty-state { margin: 0; padding: 28px 16px; border: 1px dashed #d7e3ea; border-radius: 8px; color: #7c92a3; font-size: 12px; text-align: center; }
.new-item-panel { padding: 14px; border: 1px solid #dce8ee; border-radius: 8px; background: #f8fbfc; }
.subsection-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.subsection-title h4 { margin: 0; }
.subsection-title span { color: #8a9eac; font-size: 10.5px; }
.reason-overlay { z-index: 40; background: rgba(20, 38, 52, .46); }
.reason-dialog { width: min(520px, calc(100vw - 32px)); max-width: 520px; padding: 0; overflow: hidden; border-radius: 10px; }
.reason-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 17px 18px 13px; border-bottom: 1px solid #e5edf2; }
.reason-head h3 { margin: 0; color: #203f56; font-size: 16px; }
.reason-head p { margin: 5px 0 0; color: #7c91a1; font-size: 11.5px; line-height: 1.55; }
.reason-body { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; max-height: min(62vh, 520px); overflow-y: auto; padding: 15px 18px 18px; }
.reason-body .field { grid-column: 1 / -1; margin-top: 4px; }
.reason-option { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 7px 9px; border: 1px solid #dce6ed; border-radius: 7px; background: #fff; color: #486277; font-size: 12px; }
.reason-option input { margin: 0; accent-color: #b4233b; }
.reason-option.selected { border-color: #e7a5af; background: #fff7f8; color: #9f2940; }
.reason-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid #e5edf2; background: #fbfcfd; }
.workbench-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 22px; border-top: 1px solid #e8eff4; background: #fbfdfe; color: #91a4b3; font-size: 11px; }
@media (max-width: 760px) {
  .workbench-overlay { padding: 0; }
  .onboarding-workbench { width: 100vw; height: 100vh; height: 100dvh; min-height: 0; max-height: 100vh; max-height: 100dvh; border-radius: 0; }
  .workbench-header { flex-direction: column; padding: 16px; }
  .header-actions { justify-content: flex-start; }
  .readiness-band { grid-template-columns: 90px minmax(0, 1fr); padding: 12px 16px; }
  .risk-summary { grid-column: 1 / -1; padding: 9px 0 0; border-top: 1px solid #dfe9f0; border-left: 0; }
  .workbench-body { min-height: 0; padding: 15px 16px 22px; }
  .section-heading { flex-wrap: wrap; }
  .overview-grid, .overview-lower, .workbench-form-grid, .item-grid, .material-grid { grid-template-columns: minmax(0, 1fr); }
  .field-wide { grid-column: span 1; }
  .detail-list > div { grid-template-columns: 72px minmax(0, 1fr); }
  .line-item-head, .subsection-title { flex-wrap: wrap; }
  .section-actions { justify-content: stretch; }
  .section-actions .btn { flex: 1 1 auto; justify-content: center; }
  .reason-body { grid-template-columns: minmax(0, 1fr); max-height: 65vh; }
  .reason-actions .btn { flex: 1 1 auto; }
  .workbench-footer { padding: 10px 16px; }
}
</style>
