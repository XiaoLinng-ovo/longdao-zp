<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { actionRequisition, getRequisition, getRequisitionApproval, loadDepartments, updateRequisition, type ApiDepartment, type ApiRequisition, type ApprovalDetails, type RequisitionAction } from '../api'
import { REQ_ACTION_HINT, REQ_ACTION_LABEL, REQ_REASON_REQUIRED, conversionHint, describeApproval, requisitionActionsForApproval, requisitionStatusLabel, validateRequisitionForm } from '../workflow'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { actionLabel, employmentTypeLabel, statusLabel, workModeLabel } from '../../../shared/utils/labels'
import { loadWorkflowEvents, type WorkflowEvent } from '../../../shared/api/workflow-events'
import { apiClient } from '../../../shared/api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import PageFeedback from '../../../shared/components/workflow/PageFeedback.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'

const route = useRoute()
const router = useRouter()
const id = computed(() => String(route.params.id || ''))
const request = ref<ApiRequisition | null>(null)
const loading = ref(true)
const error = ref('')
const feedback = ref('')
const acting = ref('')
const approvalDetails = ref<ApprovalDetails | null>(null)
const loadingApproval = ref(false)
const approvalCurrent = computed(() => approvalDetails.value?.current ?? null)
const approvalSteps = computed(() => approvalDetails.value?.steps ?? [])
const approvalRecords = computed(() => approvalDetails.value?.records ?? [])

const pendingAction = ref<RequisitionAction | null>(null)
const reason = ref('')

const actions = computed<RequisitionAction[]>(() => request.value ? requisitionActionsForApproval(request.value.status, {
  provider: approvalDetails.value?.current?.provider,
  status: approvalDetails.value?.current?.status,
  externalInstanceId: approvalDetails.value?.current?.externalInstanceId,
}) : [])
const dingtalkApprovalActive = computed(() => Boolean(request.value
  && request.value.status === 'pending_approval'
  && approvalDetails.value?.current?.provider === 'dingtalk'
  && approvalDetails.value.current.status === 'pending'
  && approvalDetails.value.current.externalInstanceId))
const actionHint = computed(() => (pendingAction.value ? REQ_ACTION_HINT[pendingAction.value] : ''))
const approvalInfo = computed(() => describeApproval(request.value))
const conversionMessage = computed(() => conversionHint(request.value))
const requesterLabel = computed(() => {
  const current = request.value
  if (!current) return ''
  const name = current.requesterName?.trim()
  const email = current.requesterEmail?.trim()
  if (name && email) return `${name}（${email}）`
  return name || email || current.requesterId || ''
})
const associatedJobs = ref<Array<{ id: string; code: string; title: string; status: string; updatedAt: string }>>([])
const auditEvents = ref<WorkflowEvent[]>([])
const loadingAudit = ref(false)
const showEdit = ref(false)
const editForm = ref({ title: '', departmentId: '', headcount: 1, employmentType: 'full_time', workMode: 'hybrid', location: '', justification: '' })
const editError = ref('')
const departments = ref<ApiDepartment[]>([])
const savingDetail = ref(false)
const editable = computed(() => request.value ? (request.value.status === 'draft' || request.value.status === 'rejected') : false)

function clearFlags() { error.value = ''; feedback.value = ''; editError.value = '' }

function resetEditForm() {
  if (!request.value) return
  editForm.value = {
    title: request.value.title,
    departmentId: request.value.departmentId,
    headcount: request.value.headcount,
    employmentType: request.value.employmentType,
    workMode: request.value.workMode,
    location: request.value.location || '',
    justification: request.value.justification,
  }
}

function openEdit() {
  resetEditForm()
  editError.value = ''
  showEdit.value = true
}

async function submitEdit() {
  if (savingDetail.value || !request.value) return
  const payload = {
    title: editForm.value.title.trim(),
    departmentId: editForm.value.departmentId.trim(),
    headcount: Number(editForm.value.headcount),
    employmentType: editForm.value.employmentType,
    workMode: editForm.value.workMode,
    location: editForm.value.location || undefined,
    justification: editForm.value.justification.trim(),
  }
  const validation = validateRequisitionForm(payload)
  if (validation) {
    editError.value = validation
    return
  }
  savingDetail.value = true
  clearFlags()
  try {
    request.value = await updateRequisition(request.value.id, payload)
    feedback.value = '需求信息已更新'
    showEdit.value = false
  } catch (cause) {
    editError.value = describeApiFailure(cause, '更新需求失败').message
  } finally {
    savingDetail.value = false
  }
}

async function loadAuditEvents(requestId: string) {
  loadingAudit.value = true
  auditEvents.value = []
  try {
    auditEvents.value = await loadWorkflowEvents('recruitment_request', 100).then((rows) => rows.filter((item) => item.subjectId === requestId))
  } catch {
    auditEvents.value = []
  } finally {
    loadingAudit.value = false
  }
}

async function loadApprovalDetails(requestId: string) {
  loadingApproval.value = true
  try {
    approvalDetails.value = await getRequisitionApproval(requestId)
  } catch {
    approvalDetails.value = null
  } finally {
    loadingApproval.value = false
  }
}

function approvalRecordActionLabel(action: ApprovalDetails['records'][number]['action']): string {
  if (action === 'approve') return '审批通过'
  if (action === 'reject') return '驳回'
  return '节点进度'
}

function approvalStatusLabel(status: string): string {
  if (status === 'pending') return '审批中'
  return requisitionStatusLabel(status)
}

async function loadAssociatedJobs(requestId: string) {
  associatedJobs.value = []
  if (!requestId) return
  try {
    const response = await apiClient.getJson<Array<{ id: string; code: string; title: string; status: string; updatedAt: string }>>(`/jobs?recruitmentRequestId=${encodeURIComponent(requestId)}`)
    associatedJobs.value = response.data
  } catch {
    associatedJobs.value = []
  }
}

async function refresh() {
  loading.value = true
  clearFlags()
  try {
    request.value = await getRequisition(id.value)
    departments.value = await loadDepartments()
    if (request.value.departmentId && !departments.value.some((item) => item.code === request.value?.departmentId)) departments.value.push({ id: `legacy-${request.value.departmentId}`, code: request.value.departmentId, name: request.value.department, isActive: false })
    await Promise.all([loadAssociatedJobs(request.value.id), loadAuditEvents(request.value.id), loadApprovalDetails(request.value.id)])
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取招聘需求失败').message
  } finally {
    loading.value = false
  }
}

function confirm(action: RequisitionAction) {
  if (!request.value) return
  if (REQ_REASON_REQUIRED.includes(action)) {
    reason.value = ''
    pendingAction.value = action
    return
  }
  void runAction(action)
}

async function runAction(action: RequisitionAction, suppliedReason?: string) {
  if (acting.value || !request.value) return
  const value = (suppliedReason ?? reason.value).trim()
  if (REQ_REASON_REQUIRED.includes(action) && !value) return
  pendingAction.value = null
  acting.value = action
  clearFlags()
  try {
    request.value = await actionRequisition(request.value.id, action, value || undefined)
    await Promise.all([loadAssociatedJobs(request.value.id), loadAuditEvents(request.value.id), loadApprovalDetails(request.value.id)])
    feedback.value = `${REQ_ACTION_LABEL[action]}成功，当前状态 ${requisitionStatusLabel(request.value.status)}`
  } catch (cause) {
    error.value = describeApiFailure(cause, '需求操作失败').message
  } finally {
    acting.value = ''
  }
}

function submitPending() {
  if (!pendingAction.value) return
  void runAction(pendingAction.value)
}

function openAssociatedJob(row: { id: string }) {
  router.push({ name: 'job-detail', params: { id: row.id } })
}

function openConvert() {
  if (!request.value) return
  router.push({ path: '/jobs', query: { recruitmentRequestId: request.value.id, create: '1' } })
}

onMounted(refresh)
</script>

<template>
  <PageHeader title="需求详情" :description="request?.title || ''">
    <div class="inline-actions">
      <button class="btn btn-ghost" type="button" @click="router.back">返回列表</button>
      <button class="btn btn-ghost" type="button" @click="refresh">刷新</button>
      <button v-if="editable" class="btn btn-primary" type="button" :disabled="!!acting" @click="openEdit">编辑基础信息</button>
    </div>
  </PageHeader>

  <PageFeedback :feedback="feedback" :error="error" @clear-feedback="feedback = ''" @clear-error="error = ''" />
  <div v-if="loading" class="loading-note">正在读取招聘需求...</div>

  <section v-else-if="request" class="form-panel">
    <div class="section-title">基础信息</div>
    <div class="detail-grid">
      <div class="detail-item"><span>部门</span><strong>{{ request.department }}</strong></div>
      <div class="detail-item"><span>状态</span><StatusTag :status="request.status" /></div>
      <div class="detail-item"><span>招聘人数</span><strong>{{ request.headcount }}</strong></div>
      <div class="detail-item"><span>用工类型</span><strong>{{ employmentTypeLabel(request.employmentType) }}</strong></div>
      <div class="detail-item"><span>工作模式</span><strong>{{ workModeLabel(request.workMode) }}</strong></div>
      <div class="detail-item"><span>工作地点</span><strong>{{ request.location || '未设置' }}</strong></div>
      <div class="detail-item"><span>审批人</span><strong>{{ approvalInfo.approver }}</strong></div>
      <div class="detail-item"><span>审批状态</span><StatusTag :status="approvalInfo.status" /></div>
      <div class="detail-item"><span>更新日期</span><strong>{{ request.updatedAt.slice(0, 10) }}</strong></div>
      <div class="detail-item" style="grid-column: 1 / -1"><span>招聘理由</span><strong>{{ request.justification }}</strong></div>
      <div v-if="conversionMessage" class="detail-item hint" style="grid-column: 1 / -1"><span>转化提示</span><strong>{{ conversionMessage }}</strong></div>
      <div v-if="requesterLabel" class="detail-item"><span>当前操作账户</span><strong>{{ requesterLabel }}</strong></div>
    </div>

    <div v-if="approvalInfo.history.length" class="error-note" style="margin-top:14px">
      <div v-for="(item, index) in approvalInfo.history" :key="index">
        <div>{{ item.actedAt ? `${item.actedAt.slice(0, 10)} ` : '' }}{{ statusLabel(item.status) }} · {{ item.approver || '系统' }}</div>
        <div v-if="item.comment">{{ item.comment }}</div>
      </div>
    </div>

    <div class="section-title" style="margin-top:18px">可执行动作</div>
    <div class="actions-panel">
      <button
        v-for="action in actions"
        :key="action"
        type="button"
        class="btn"
        :class="action === 'reject' || action === 'close' || action === 'cancel' ? 'btn-danger' : (action === 'approve' || action === 'submit' || action === 'resubmit' ? 'btn-primary' : 'btn-ghost')"
        :disabled="acting === action"
        @click="confirm(action)"
      >
        {{ acting === action ? '处理中...' : REQ_ACTION_LABEL[action] }}
      </button>
      <button v-if="request.status === 'approved' && (!request.convertedJobIds || !request.convertedJobIds.length)" class="btn btn-primary" type="button" :disabled="!!acting" @click="openConvert">新建关联岗位</button>
      <button v-if="request.status === 'approved' && request.convertedJobIds && request.convertedJobIds.length" class="btn btn-primary" type="button" :disabled="!!acting" @click="confirm('convert')">转换为岗位</button>
      <span v-if="dingtalkApprovalActive" class="hint">请在钉钉中完成审批，平台暂不提供通过、驳回或撤回操作。</span>
      <span v-else-if="!actions.length" class="hint">当前状态无可执行动作</span>
    </div>
    <div v-if="pendingAction" class="hint">{{ actionHint }}</div>

    <section v-if="loadingApproval || approvalDetails?.current" class="section" style="margin-top:18px">
      <div class="section-title">钉钉审批详情</div>
      <div v-if="loadingApproval" class="loading-note">正在读取钉钉审批...</div>
      <template v-else-if="approvalCurrent">
        <div class="detail-grid">
          <div class="detail-item"><span>审批来源</span><strong>{{ approvalCurrent.provider === 'dingtalk' ? '钉钉' : approvalCurrent.provider || '平台' }}</strong></div>
          <div v-if="approvalCurrent.externalInstanceId" class="detail-item"><span>审批实例</span><strong>{{ approvalCurrent.externalInstanceId }}</strong></div>
          <div class="detail-item"><span>审批状态</span><strong>{{ approvalStatusLabel(approvalCurrent.status) }}</strong></div>
          <div v-if="approvalCurrent.completedAt" class="detail-item"><span>完成时间</span><strong>{{ approvalCurrent.completedAt }}</strong></div>
        </div>
        <div v-if="approvalSteps.length" class="table-wrap" style="margin-top:14px">
          <table>
            <thead><tr><th>节点</th><th>审批角色</th><th>状态</th><th>处理时间</th></tr></thead>
            <tbody><tr v-for="step in approvalSteps" :key="step.id"><td>{{ step.nodeName || step.name }}</td><td>{{ step.approverRole }}</td><td>{{ approvalStatusLabel(step.status) }}</td><td>{{ step.actedAt || '-' }}</td></tr></tbody>
          </table>
        </div>
        <div v-if="approvalRecords.length" class="table-wrap" style="margin-top:14px">
          <table>
            <thead><tr><th>时间</th><th>动作</th><th>审批人</th><th>说明</th></tr></thead>
            <tbody><tr v-for="record in approvalRecords" :key="record.id"><td>{{ record.createdAt }}</td><td>{{ approvalRecordActionLabel(record.action) }}</td><td>{{ record.approver || record.actorId || '系统' }}</td><td>{{ record.comment || '-' }}</td></tr></tbody>
          </table>
        </div>
      </template>
    </section>

    <section class="section" style="margin-top:18px">
      <div class="section-title">流程审计</div>
      <div v-if="loadingAudit" class="loading-note">正在读取审计记录...</div>
      <div v-else-if="!auditEvents.length" class="hint">暂无流程审计记录</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr><th>时间</th><th>动作</th><th>状态流转</th><th>操作人</th><th>原因</th></tr>
          </thead>
          <tbody>
            <tr v-for="event in auditEvents" :key="event.id">
              <td>{{ (event.createdAt || '').slice(0, 19).replace('T', ' ') }}</td>
              <td>{{ actionLabel(event.action) }}</td>
              <td>{{ statusLabel(event.fromStatus) }} → {{ statusLabel(event.toStatus) }}</td>
              <td>{{ event.actorName || '系统' }}</td>
              <td>{{ event.reason || '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="associatedJobs.length" class="section">
      <div class="section-title">关联岗位</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>岗位名称</th><th>状态</th><th>更新时间</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in associatedJobs" :key="row.id" class="row-clickable" role="link" tabindex="0" @click="openAssociatedJob(row)" @keydown.enter="openAssociatedJob(row)">
              <td><span class="row-link" @click.stop="openAssociatedJob(row)">{{ row.title }}</span></td>
              <td><StatusTag :status="row.status" /></td>
              <td>{{ (row.updatedAt || '').slice(0, 10) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </section>

  <div v-if="pendingAction" class="overlay" role="presentation" @click.self="pendingAction = null">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>{{ REQ_ACTION_LABEL[pendingAction] }}</h3>
      <p>需求 {{ request?.title }}</p>
      <div class="form-field">
        <label for="req-detail-reason">操作原因（必填）</label>
        <textarea id="req-detail-reason" v-model="reason" rows="3" placeholder="请填写操作原因"></textarea>
      </div>
      <div class="dialog-buttons">
        <button class="btn btn-ghost" type="button" @click="pendingAction = null">取消</button>
        <button class="btn btn-primary" type="button" :disabled="!reason.trim()" @click="submitPending">确认</button>
      </div>
    </div>
  </div>

  <section v-if="showEdit && request" class="form-panel">
    <div class="section-title">编辑基础信息</div>
    <div v-if="editError" class="error-note">{{ editError }}</div>
    <div class="form-grid">
      <div class="form-field"><label>岗位名称 <span class="required">*</span></label><input v-model="editForm.title" /></div>
      <div class="form-field"><label>部门 <span class="required">*</span></label><select v-model="editForm.departmentId"><option value="">请选择部门</option><option v-for="department in departments" :key="department.id" :value="department.code" :disabled="!department.isActive">{{ department.name }}{{ department.isActive ? '' : '（已停用，仅保留历史）' }}</option></select></div>
      <div class="form-field"><label>招聘人数 <span class="required">*</span></label><input v-model.number="editForm.headcount" type="number" min="1" /></div>
      <div class="form-field"><label>用工类型 <span class="required">*</span></label><select v-model="editForm.employmentType"><option value="full_time">全职</option><option value="part_time">兼职</option><option value="internship">实习</option></select></div>
      <div class="form-field"><label>工作模式 <span class="required">*</span></label><select v-model="editForm.workMode"><option value="hybrid">混合办公</option><option value="onsite">现场办公</option><option value="remote">远程</option></select></div>
      <div class="form-field"><label>工作地点</label><input v-model="editForm.location" /></div>
      <div class="form-field" style="grid-column: 1 / -1"><label>招聘理由 <span class="required">*</span></label><input v-model="editForm.justification" /></div>
    </div>
    <div class="inline-actions" style="margin-top:14px">
      <button class="btn btn-primary" type="button" :disabled="savingDetail" @click="submitEdit">{{ savingDetail ? '保存中...' : '保存' }}</button>
      <button class="btn btn-ghost" type="button" :disabled="savingDetail" @click="showEdit = false">取消</button>
    </div>
  </section>
</template>



<style scoped>
.row-clickable { cursor: pointer; }
.row-clickable:hover td { background: #f8fafc; }
.row-link { color: var(--primary); font-weight: 500; }
.row-link:hover { text-decoration: underline; }
</style>
