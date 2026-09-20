<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { listAdminChecks, loadWorkflowEvents, listAdminUsers, listAdminRoles, listAdminDepartments, createAdminDepartment, updateAdminDepartment, deleteAdminDepartment, getAdminSettings, updateAdminSettings, getDingTalkSettings, updateDingTalkSettings, getResumeVirusScanSetting, updateResumeVirusScanSetting, listFailedAnalysisTasks, listAdminAuditLogs, updateAdminUser, updateAdminRole, type AdminCheckRow, type WorkflowEvent, type AdminUser, type AdminRole, type AdminDepartment, type AdminSettings, type DingTalkEnvSettings, type AdminAnalysisTask, type AdminAuditLog } from '../api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import SecurityNotice from '../components/SecurityNotice.vue'

const rows = ref<AdminCheckRow[]>([])
const events = ref<WorkflowEvent[]>([])
const subjectType = ref<WorkflowEvent['subjectType'] | ''>('')
const loading = ref(true)
const error = ref('')
const users = ref<AdminUser[]>([])
const roles = ref<AdminRole[]>([])
const departments = ref<AdminDepartment[]>([])
const departmentDraft = ref({ code: '', name: '' })
const savingDepartment = ref<string | null>(null)
const creatingDepartment = ref(false)
// 物理删除需要二次确认，避免误点（页面不使用 window.confirm，便于自动化验收）
const confirmingDepartmentId = ref<string | null>(null)
// 部门区块的行内反馈：行级操作失败（例如删除被引用阻断）只提示本区块，不替换整页内容
const notice = ref('')
const departmentError = ref('')
// 与后端 admin/service.ts 的校验保持一致：3-64 位、小写字母开头、仅含小写字母/数字/短横线
const departmentCodeValid = computed(() => /^[a-z][a-z0-9-]{2,63}$/.test(departmentDraft.value.code.trim()))
const settings = ref<AdminSettings>({})
const failedTasks = ref<AdminAnalysisTask[]>([])
const auditLogs = ref<AdminAuditLog[]>([])
const savingUser = ref<string | null>(null)
const savingRole = ref<string | null>(null)
const savingSettings = ref(false)
const settingsDraft = ref<Record<string, string>>({})
const dingTalkSettings = ref<DingTalkEnvSettings>({})
const dingTalkDraft = ref<Record<string, string>>({})
const savingDingTalk = ref(false)
const resumeVirusScanEnabled = ref(false)
const savingResumeVirusScan = ref(false)

const dingTalkFields = [
  { key: 'DINGTALK_APP_KEY', label: 'AppKey', secret: false, help: '钉钉开放平台 → 应用开发 → 企业内部应用 → 凭证与基础信息。', href: 'https://open.dingtalk.com/document/orgapp/obtain-the-appkey-and-appsecret' },
  { key: 'DINGTALK_APP_SECRET', label: 'AppSecret', secret: true, help: '与 AppKey 同一页面获取；请勿提交到代码仓库。', href: 'https://open.dingtalk.com/document/orgapp/obtain-the-appkey-and-appsecret' },
  { key: 'DINGTALK_INTEGRATION_TOKEN', label: '岗位同步 Token', secret: true, help: '由钉钉宜搭/连接器调用本平台岗位接口时使用，自行生成一段高强度随机字符串。', href: 'https://open.dingtalk.com/document/orgapp/overview-of-the-dingtalk-server-side-api' },
  { key: 'DINGTALK_CALLBACK_TOKEN', label: '回调 Token', secret: true, help: '钉钉应用 → 事件与回调 → HTTP 回调中配置并复制。', href: 'https://open.dingtalk.com/document/orgapp/event订阅' },
  { key: 'DINGTALK_CALLBACK_AES_KEY', label: '回调加密 AES Key', secret: true, help: '同一 HTTP 回调配置页面生成或复制 43 位加密 Key。', href: 'https://open.dingtalk.com/document/orgapp/event订阅' },
  { key: 'DINGTALK_CALLBACK_CORP_ID', label: '企业 CorpId', secret: false, help: '钉钉管理后台 → 设置 → 企业信息 → CorpId。', href: 'https://open.dingtalk.com/document/orgapp/query-the-enterprise-corp-id' },
] as const

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
  departmentError.value = ''
  try {
    const [checks, audit, adminUsers, adminRoles, adminDepartments, adminSettings, adminDingTalkSettings, adminVirusScan, tasks, logs] = await Promise.all([
      listAdminChecks(),
      loadWorkflowEvents(subjectType.value || undefined, 80),
      listAdminUsers(), listAdminRoles(), listAdminDepartments(), getAdminSettings(), getDingTalkSettings(), getResumeVirusScanSetting(), listFailedAnalysisTasks(), listAdminAuditLogs(80),
    ])
    rows.value = checks
    events.value = audit
    users.value = adminUsers; roles.value = adminRoles; departments.value = adminDepartments; settings.value = adminSettings; dingTalkSettings.value = adminDingTalkSettings; resumeVirusScanEnabled.value = adminVirusScan.enabled; failedTasks.value = tasks; auditLogs.value = logs
    settingsDraft.value = Object.fromEntries(Object.entries(adminSettings).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]))
    dingTalkDraft.value = Object.fromEntries(dingTalkFields.map(({ key }) => [key, '']))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取系统配置失败'
  } finally {
    loading.value = false
  }
}

async function saveResumeVirusScan() {
  savingResumeVirusScan.value = true; error.value = ''
  try { resumeVirusScanEnabled.value = (await updateResumeVirusScanSetting(resumeVirusScanEnabled.value)).enabled }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '保存简历病毒扫描设置失败' }
  finally { savingResumeVirusScan.value = false }
}

async function saveUser(user: AdminUser) {
  savingUser.value = user.id; error.value = ''
  try { const saved = await updateAdminUser(user.id, { displayName: user.displayName, isActive: user.isActive, role: user.role, departmentCode: user.departmentCode }); users.value = users.value.map((item) => item.id === user.id ? saved : item) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '保存用户失败' }
  finally { savingUser.value = null }
}

async function saveRole(role: AdminRole) {
  savingRole.value = role.id; error.value = ''
  try { const saved = await updateAdminRole(role.id, { name: role.name }); roles.value = roles.value.map((item) => item.id === role.id ? saved : item) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '保存角色失败' }
  finally { savingRole.value = null }
}

async function saveDepartment(department: AdminDepartment) {
  savingDepartment.value = department.id; departmentError.value = ''
  try { const saved = await updateAdminDepartment(department.id, { name: department.name }); departments.value = departments.value.map((item) => item.id === department.id ? saved : item) }
  catch (cause) { departmentError.value = cause instanceof Error ? cause.message : '保存部门名称失败' }
  finally { savingDepartment.value = null }
}

// 停用/启用：软停用，保留历史记录（见 docs/superpowers/specs/2026-09-18-department-management-design.md）
async function toggleDepartment(department: AdminDepartment) {
  savingDepartment.value = department.id; departmentError.value = ''
  try { const saved = await updateAdminDepartment(department.id, { isActive: !department.isActive }); departments.value = departments.value.map((item) => item.id === department.id ? saved : item) }
  catch (cause) { departmentError.value = cause instanceof Error ? cause.message : '更新部门状态失败' }
  finally { savingDepartment.value = null }
}

async function addDepartment() {
  creatingDepartment.value = true; departmentError.value = ''
  try { departments.value = [await createAdminDepartment(departmentDraft.value), ...departments.value]; departmentDraft.value = { code: '', name: '' } }
  catch (cause) { departmentError.value = cause instanceof Error ? cause.message : '新增部门失败' }
  finally { creatingDepartment.value = false }
}

// 物理删除：仍有用户/招聘需求/岗位/子部门引用时，后端返回 400 并给出具体原因
// （见 apps/api/src/admin/service.ts 的 deleteDepartment）
function askRemoveDepartment(department: AdminDepartment) {
  confirmingDepartmentId.value = department.id
  notice.value = ''; departmentError.value = ''
}

function cancelRemoveDepartment() {
  confirmingDepartmentId.value = null
}

async function removeDepartment(department: AdminDepartment) {
  savingDepartment.value = department.id; departmentError.value = ''; notice.value = ''
  try {
    const removed = await deleteAdminDepartment(department.id)
    departments.value = departments.value.filter((item) => item.id !== department.id)
    confirmingDepartmentId.value = null
    notice.value = removed.removedApprovalPolicies
      ? `已删除部门「${removed.name}」，同时清除 ${removed.removedApprovalPolicies} 条部门审批策略。`
      : `已删除部门「${removed.name}」。`
  } catch (cause) { departmentError.value = cause instanceof Error ? cause.message : '删除部门失败' }
  finally { savingDepartment.value = null }
}

async function saveSettings() {
  savingSettings.value = true; error.value = ''
  try {
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(settingsDraft.value)) { try { patch[key] = JSON.parse(value) } catch { patch[key] = value } }
    settings.value = await updateAdminSettings(patch)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存系统设置失败' }
  finally { savingSettings.value = false }
}

async function saveDingTalkSettings() {
  savingDingTalk.value = true; error.value = ''
  try {
    const patch = Object.fromEntries(Object.entries(dingTalkDraft.value).filter(([, value]) => value.trim() !== ''))
    dingTalkSettings.value = await updateDingTalkSettings(patch)
    dingTalkDraft.value = Object.fromEntries(dingTalkFields.map(({ key }) => [key, '']))
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存钉钉配置失败' }
  finally { savingDingTalk.value = false }
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
      <h3 class="section-title">用户与角色</h3>
      <div class="table-wrap">
        <table><thead><tr><th>用户</th><th>角色</th><th>部门</th><th>状态</th><th>操作</th></tr></thead><tbody>
          <tr v-for="user in users" :key="user.id"><td><strong>{{ user.displayName }}</strong><br><small>{{ user.email }}</small></td><td><input v-model="user.role" aria-label="用户角色" /></td><td><select v-model="user.departmentCode" aria-label="用户部门"><option :value="null">未分配</option><option v-for="department in departments" :key="department.id" :value="department.code">{{ department.name }}（{{ department.code }}）</option></select></td><td><label><input v-model="user.isActive" type="checkbox" /> 启用</label></td><td><button class="btn btn-primary" type="button" :disabled="savingUser === user.id" @click="saveUser(user)">{{ savingUser === user.id ? '保存中...' : '保存' }}</button></td></tr>
          <tr v-if="!users.length"><td colspan="5" class="table-empty">暂无用户</td></tr>
        </tbody></table>
      </div>
      <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>角色代码</th><th>角色名称</th><th>操作</th></tr></thead><tbody>
        <tr v-for="role in roles" :key="role.id"><td>{{ role.code }}</td><td><span>{{ role.name }}</span> <input v-model="role.name" aria-label="角色名称" /></td><td><button class="btn btn-primary" type="button" :disabled="savingRole === role.id" @click="saveRole(role)">{{ savingRole === role.id ? '保存中...' : '保存' }}</button></td></tr>
        <tr v-if="!roles.length"><td colspan="3" class="table-empty">暂无角色</td></tr>
      </tbody></table></div>
    </section>

    <section class="section">
      <div class="section-heading"><div><h3 class="section-title">部门管理</h3><p class="muted">停用后部门不再出现在新建需求的下拉选项中，历史记录仍保留；已无关联记录的部门可以直接删除。</p></div></div>
      <div class="inline-actions" style="margin-bottom:8px"><input v-model="departmentDraft.code" placeholder="部门编码，如 dept-ops" aria-label="部门编码" :aria-invalid="departmentDraft.code.trim() !== '' && !departmentCodeValid" /><input v-model="departmentDraft.name" placeholder="部门名称" aria-label="部门名称" /><button class="btn btn-primary" type="button" :disabled="creatingDepartment" @click="addDepartment">{{ creatingDepartment ? '新增中...' : '新增部门' }}</button></div>
      <p class="muted dept-code-hint" :class="{ 'is-invalid': departmentDraft.code.trim() !== '' && !departmentCodeValid }">编码规则：3-64 位，以小写字母开头，只能包含小写字母、数字或短横线（如 dept-ops）；创建后不可修改。部门名称可随时修改。</p>
      <p v-if="notice" class="muted dept-code-hint" role="status">{{ notice }}</p>
      <p v-if="departmentError" class="error-note" role="alert">{{ departmentError }}</p>
      <div class="table-wrap"><table><thead><tr><th>编码</th><th>名称</th><th>状态</th><th>操作</th></tr></thead><tbody>
        <tr v-for="department in departments" :key="department.id"><td><code>{{ department.code }}</code></td><td><input v-model="department.name" aria-label="部门名称" /></td><td>{{ department.isActive ? '启用' : '已停用' }}</td><td class="row-actions"><button class="btn btn-primary" type="button" :disabled="savingDepartment === department.id" @click="saveDepartment(department)">{{ savingDepartment === department.id ? '保存中...' : '保存名称' }}</button><button class="btn btn-ghost" type="button" :disabled="savingDepartment === department.id" @click="toggleDepartment(department)">{{ department.isActive ? '停用' : '启用' }}</button><template v-if="confirmingDepartmentId === department.id"><button class="btn btn-danger" type="button" :disabled="savingDepartment === department.id" @click="removeDepartment(department)">{{ savingDepartment === department.id ? '删除中...' : '确认删除' }}</button><button class="btn btn-ghost" type="button" :disabled="savingDepartment === department.id" @click="cancelRemoveDepartment">取消</button></template><button v-else class="btn btn-danger" type="button" :disabled="savingDepartment === department.id" @click="askRemoveDepartment(department)">删除</button></td></tr>
        <tr v-if="!departments.length"><td colspan="4" class="table-empty">暂无部门</td></tr>
      </tbody></table></div>
    </section>

    <section class="section">
      <div class="section-heading"><h3 class="section-title">系统设置</h3><button class="btn btn-primary" type="button" :disabled="savingSettings" @click="saveSettings">{{ savingSettings ? '保存中...' : '保存设置' }}</button></div>
      <div class="form-grid form-panel"><div v-for="(_, key) in settingsDraft" :key="key" class="form-field"><label :for="`setting-${key}`">{{ key }}</label><input :id="`setting-${key}`" v-model="settingsDraft[key]" /><small>{{ settingsDraft[key] }}</small></div><div v-if="!Object.keys(settingsDraft).length" class="table-empty">暂无系统设置</div></div>
      <div class="settings-toggle"><div><strong>简历病毒扫描</strong><p class="muted">开启后，新上传简历会先进入隔离区并由 ClamAV 扫描；默认关闭。</p></div><label><input v-model="resumeVirusScanEnabled" type="checkbox" :disabled="savingResumeVirusScan" @change="saveResumeVirusScan" /> {{ resumeVirusScanEnabled ? '已开启' : '已关闭' }}</label></div>
    </section>

    <section class="section">
      <div class="section-heading"><div><h3 class="section-title">钉钉集成配置</h3><p class="muted">保存后写入 <code>ENV_FILE_PATH</code> 指定的 .env 文件，并立即对当前 API 进程生效。</p></div><button class="btn btn-primary" type="button" :disabled="savingDingTalk" @click="saveDingTalkSettings">{{ savingDingTalk ? '保存中...' : '保存钉钉配置' }}</button></div>
      <div class="form-grid form-panel">
        <div v-for="field in dingTalkFields" :key="field.key" class="form-field">
          <label :for="`dingtalk-${field.key}`">{{ field.label }} <code>{{ field.key }}</code></label>
          <input :id="`dingtalk-${field.key}`" v-model="dingTalkDraft[field.key]" :type="field.secret ? 'password' : 'text'" :placeholder="dingTalkSettings[field.key]?.configured ? '已配置，留空表示不修改' : '未配置'" autocomplete="new-password" />
          <small>{{ field.help }} <a :href="field.href" target="_blank" rel="noreferrer">查看钉钉官方文档</a></small>
        </div>
      </div>
    </section>

    <section class="section">
      <h3 class="section-title">失败分析任务</h3><div class="table-wrap"><table><thead><tr><th>任务</th><th>简历</th><th>重试次数</th><th>错误</th><th>创建时间</th></tr></thead><tbody>
        <tr v-for="task in failedTasks" :key="task.id"><td>{{ task.id }}</td><td>{{ task.resumeId }}</td><td>{{ task.attempts }}</td><td>{{ task.lastError || '—' }}</td><td>{{ new Date(task.createdAt).toLocaleString() }}</td></tr><tr v-if="!failedTasks.length"><td colspan="5" class="table-empty">暂无失败任务</td></tr>
      </tbody></table></div>
    </section>

    <section class="section">
      <h3 class="section-title">管理审计日志</h3><div class="table-wrap"><table><thead><tr><th>时间</th><th>操作</th><th>资源</th><th>操作人</th><th>请求 ID</th></tr></thead><tbody>
        <tr v-for="log in auditLogs" :key="log.id"><td>{{ new Date(log.createdAt).toLocaleString() }}</td><td>{{ log.action }}</td><td>{{ log.resourceType }}{{ log.resourceId ? ` / ${log.resourceId}` : '' }}</td><td>{{ log.actorEmail || log.actorId || '—' }}</td><td>{{ log.requestId || '—' }}</td></tr><tr v-if="!auditLogs.length"><td colspan="5" class="table-empty">暂无管理审计日志</td></tr>
      </tbody></table></div>
    </section>

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
.row-actions { display: flex; gap: 8px; }
.dept-code-hint { margin: 0 0 12px; font-size: 12.5px; color: var(--muted, #64748b); }
.dept-code-hint.is-invalid { color: #b91c1c; }
</style>
