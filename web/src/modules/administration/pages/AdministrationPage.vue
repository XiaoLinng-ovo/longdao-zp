<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { listAdminChecks, loadWorkflowEvents, type AdminCheckRow, type WorkflowEvent } from '../api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import SecurityNotice from '../components/SecurityNotice.vue'

const rows = ref<AdminCheckRow[]>([])
const events = ref<WorkflowEvent[]>([])
const subjectType = ref<WorkflowEvent['subjectType'] | ''>('')
const loading = ref(true)
const error = ref('')

const subjectLabels: Record<WorkflowEvent['subjectType'], string> = {
  recruitment_request: '招聘需求',
  job: '岗位',
  offer: 'Offer',
  onboarding: '入职归档',
  candidate: '候选人',
  application: '职位申请',
  interview: '面试',
}

const actionLabels: Record<string, string> = {
  submit: '提交审批', submit_approval: '提交审批', approve: '审批通过', reject: '审批驳回', withdraw: '撤回',
  request_submitted: '提交审批', request_approved: '审批通过', request_rejected: '审批驳回', converted: '转为岗位',
  publish: '发布', pause: '暂停', resume: '恢复', close: '关闭', create_job: '新建岗位', job_created: '新建岗位', spec_created: '新建说明书', jd_created: '新建 JD', confirm_spec: '确认说明书', spec_confirmed: '确认说明书', confirm_jd: '确认 JD', jd_confirmed: '确认 JD',
  create: '创建', revise: '修订', send: '发送', accept: '接受', decline: '拒绝', cancel: '取消', expire: '过期',
  archive_onboarding: '入职归档',
  status_changed: '变更申请状态', feedback_submitted: '提交反馈', feedback_locked: '锁定反馈',
}

const eventSummary = computed(() => {
  const counter = new Map<string, number>()
  for (const event of events.value) {
    counter.set(event.subjectType, (counter.get(event.subjectType) ?? 0) + 1)
  }
  return [...counter.entries()].map(([type, count]) => ({ type, label: subjectLabels[type as WorkflowEvent['subjectType']], count }))
})

function subjectName(event: WorkflowEvent) {
  return event.subjectLabel || event.subjectId
}

function actionName(action: string) {
  return actionLabels[action] ?? action.replaceAll('_', ' ')
}

function statusText(status?: string) {
  return status || '—'
}

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const [checks, audit] = await Promise.all([
      listAdminChecks(),
      loadWorkflowEvents(subjectType.value || undefined, 80),
    ])
    rows.value = checks
    events.value = audit
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取系统配置失败'
  } finally {
    loading.value = false
  }
}

async function changeSubject() {
  await refresh()
}

onMounted(refresh)
</script>

<template>
  <PageHeader title="管理后台" description="查看招聘团队、流程与系统服务配置">
    <button class="btn btn-ghost" type="button" :disabled="loading" @click="refresh">刷新</button>
  </PageHeader>
  <div v-if="loading" class="loading-note">正在读取系统配置与审计记录...</div>
  <div v-else-if="error" class="error-note" role="alert">{{ error }} <button class="btn btn-ghost" type="button" @click="refresh">重试</button></div>
  <template v-else>
    <section class="section">
      <h3 class="section-title">系统运行检查</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>配置类别</th><th>负责人</th><th>状态</th><th>当前配置</th></tr></thead>
          <tbody>
            <tr v-for="row in rows" :key="row.category">
              <td><strong>{{ row.category }}</strong></td><td>{{ row.owner }}</td>
              <td><StatusTag :status="row.status" /></td><td>{{ row.detail }}</td>
            </tr>
            <tr v-if="!rows.length"><td colspan="4" class="table-empty">暂无配置</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="section">
      <div class="section-heading">
        <h3 class="section-title">流程审计记录</h3>
        <label class="filter">
          <span>筛选实体</span>
          <select v-model="subjectType" @change="changeSubject">
            <option value="">全部</option>
            <option value="recruitment_request">招聘需求</option>
            <option value="job">岗位</option>
            <option value="offer">Offer</option>
            <option value="onboarding">入职归档</option>
            <option value="candidate">候选人</option>
            <option value="application">职位申请</option>
            <option value="interview">面试</option>
          </select>
        </label>
      </div>
      <div v-if="eventSummary.length" class="audit-summary">
        <span v-for="item in eventSummary" :key="item.type" class="audit-chip">{{ item.label }} · {{ item.count }}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>时间</th><th>实体类型</th><th>对象</th><th>动作</th><th>状态流转</th><th>操作人</th><th>原因</th></tr></thead>
          <tbody>
            <tr v-for="event in events" :key="event.id">
              <td>{{ new Date(event.createdAt).toLocaleString() }}</td>
              <td>{{ subjectLabels[event.subjectType] }}</td>
              <td><strong>{{ subjectName(event) }}</strong></td>
              <td>{{ actionName(event.action) }}</td>
              <td>{{ statusText(event.fromStatus) }} → {{ statusText(event.toStatus) }}</td>
              <td>{{ event.actorId }}</td>
              <td>{{ event.reason || '—' }}</td>
            </tr>
            <tr v-if="!events.length"><td colspan="7" class="table-empty">暂无流程审计记录</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>
  <SecurityNotice />
</template>

<style scoped>
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.filter { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-muted, #64748b); }
.audit-summary { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.audit-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 999px; background: #eef2ff; color: #4338ca; font-size: 13px; font-weight: 500; }
</style>
