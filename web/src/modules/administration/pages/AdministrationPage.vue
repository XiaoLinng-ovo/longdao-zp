<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { listAdminChecks, loadWorkflowEvents, listAdminUsers, listAdminRoles, listAdminDepartments, createAdminDepartment, updateAdminDepartment, deleteAdminDepartment, getAdminSettings, updateAdminSettings, getDingTalkSettings, updateDingTalkSettings, getResumeVirusScanSetting, updateResumeVirusScanSetting, getAiSettings, saveAiSettings, testAiConnection, listFailedAnalysisTasks, listAdminAuditLogs, updateAdminUser, type AdminCheckRow, type WorkflowEvent, type AdminUser, type AdminRole, type AdminDepartment, type AdminSettings, type DingTalkEnvSettings, type AiSettings, type AiConnectionTestResult, type AdminAnalysisTask, type AdminAuditLog } from '../api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import SecurityNotice from '../components/SecurityNotice.vue'
import { actionLabel, statusLabel } from '../../../shared/utils/labels'

const rows = ref<AdminCheckRow[]>([])
const events = ref<WorkflowEvent[]>([])
const subjectType = ref<WorkflowEvent['subjectType'] | ''>('')
const loading = ref(true)
const error = ref('')
const users = ref<AdminUser[]>([])
const roles = ref<AdminRole[]>([])
const departments = ref<AdminDepartment[]>([])
const departmentDraft = ref({ name: '' })
const savingDepartment = ref<string | null>(null)
const creatingDepartment = ref(false)
// 物理删除需要二次确认，避免误点（页面不使用 window.confirm，便于自动化验收）
const confirmingDepartmentId = ref<string | null>(null)
// 重命名是显式动作：名称默认只读，避免随手改动被引用的部门
const renamingDepartmentId = ref<string | null>(null)
const departmentRenameDraft = ref('')
// 部门区块的行内反馈：行级操作失败（例如删除被引用阻断）只提示本区块，不替换整页内容
const notice = ref('')
const departmentError = ref('')
const settings = ref<AdminSettings>({})
const failedTasks = ref<AdminAnalysisTask[]>([])
const auditLogs = ref<AdminAuditLog[]>([])
const savingUser = ref<string | null>(null)
const savingSettings = ref(false)
const settingsDraft = ref<Record<string, string>>({})
const dingTalkSettings = ref<DingTalkEnvSettings>({})
const dingTalkDraft = ref<Record<string, string>>({})
const savingDingTalk = ref(false)
const resumeVirusScanEnabled = ref(false)
const savingResumeVirusScan = ref(false)
const aiSettings = ref<AiSettings | null>(null)
const aiTestResult = ref<AiConnectionTestResult | null>(null)
const testingAiConnection = ref(false)
const savingAiSettings = ref(false)
const aiDraft = ref({ baseUrl: '', apiKey: '', model: '', timeoutMs: '' })
const confirmingAiKeyClear = ref(false)
const aiModels = ref<string[]>([])
/** 下拉候选：测试连接拉到的全部模型，外加已保存的模型（可能不在返回列表里）。 */
const aiModelOptions = computed(() => {
  const configured = aiSettings.value?.env.OPENAI_MODEL.value.trim()
  const list = [...aiModels.value]
  if (configured && !list.includes(configured)) list.unshift(configured)
  return list
})

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

const eventSummary = computed(() => {
  const counter = new Map<string, number>()
  for (const event of events.value) {
    counter.set(event.subjectType, (counter.get(event.subjectType) ?? 0) + 1)
  }
  return [...counter.entries()].map(([type, count]) => ({ type, label: subjectLabels[type as WorkflowEvent['subjectType']], count }))
})

const hasSettings = computed(() => Object.keys(settingsDraft.value).length > 0)

function subjectName(event: WorkflowEvent) {
  return event.subjectLabel || event.subjectId
}

async function refresh() {
  loading.value = true
  error.value = ''
  departmentError.value = ''
  try {
    const [checks, audit, adminUsers, adminRoles, adminDepartments, adminSettings, adminDingTalkSettings, adminVirusScan, aiConfig, tasks, logs] = await Promise.all([
      listAdminChecks(),
      loadWorkflowEvents(subjectType.value || undefined, 80),
      listAdminUsers(), listAdminRoles(), listAdminDepartments(), getAdminSettings(), getDingTalkSettings(), getResumeVirusScanSetting(), getAiSettings().catch(() => null), listFailedAnalysisTasks(), listAdminAuditLogs(80),
    ])
    rows.value = checks
    events.value = audit
    users.value = adminUsers; roles.value = adminRoles; departments.value = adminDepartments; settings.value = adminSettings; dingTalkSettings.value = adminDingTalkSettings; resumeVirusScanEnabled.value = adminVirusScan.enabled; if (aiConfig) applyAiSettings(aiConfig); failedTasks.value = tasks; auditLogs.value = logs
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

async function runAiConnectionTest() {
  testingAiConnection.value = true; error.value = ''; aiTestResult.value = null
  try {
    const result = await testAiConnection({
      ...(aiDraft.value.baseUrl.trim() ? { baseUrl: aiDraft.value.baseUrl.trim() } : {}),
      ...(aiDraft.value.apiKey.trim() ? { apiKey: aiDraft.value.apiKey.trim() } : {}),
    })
    aiTestResult.value = result
    aiModels.value = result.models
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '测试模型连接失败'
  } finally {
    testingAiConnection.value = false
  }
}

function applyAiSettings(settings: AiSettings) {
  aiSettings.value = settings
  aiDraft.value = {
    baseUrl: settings.env.OPENAI_BASE_URL.value,
    apiKey: '',
    model: settings.env.OPENAI_MODEL.value,
    timeoutMs: settings.env.OPENAI_TIMEOUT_MS.value,
  }
}

async function submitAiSettings() {
  savingAiSettings.value = true; error.value = ''; aiTestResult.value = null
  try {
    const patch: Record<string, string> = {
      OPENAI_BASE_URL: aiDraft.value.baseUrl.trim(),
      OPENAI_MODEL: aiDraft.value.model.trim(),
      OPENAI_TIMEOUT_MS: aiDraft.value.timeoutMs.trim(),
    }
    // 密钥为写入专用：留空表示保持原值，避免把掩码回写进 .env。
    if (aiDraft.value.apiKey.trim()) patch.OPENAI_API_KEY = aiDraft.value.apiKey.trim()
    applyAiSettings(await saveAiSettings(patch))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存模型配置失败'
  } finally {
    savingAiSettings.value = false
  }
}

/** 密钥不回显，删除只能走这个显式动作。 */
async function clearAiApiKey() {
  savingAiSettings.value = true; error.value = ''; aiTestResult.value = null
  try {
    applyAiSettings(await saveAiSettings({ OPENAI_API_KEY: '' }))
    confirmingAiKeyClear.value = false
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '清除密钥失败'
  } finally {
    savingAiSettings.value = false
  }
}

async function saveUser(user: AdminUser) {
  savingUser.value = user.id; error.value = ''
  try { const saved = await updateAdminUser(user.id, { displayName: user.displayName, isActive: user.isActive, role: user.role, departmentCode: user.departmentCode }); users.value = users.value.map((item) => item.id === user.id ? saved : item) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '保存用户失败' }
  finally { savingUser.value = null }
}

function startRenameDepartment(department: AdminDepartment) {
  renamingDepartmentId.value = department.id
  departmentRenameDraft.value = department.name
  departmentError.value = ''; notice.value = ''
}

function cancelRenameDepartment() {
  renamingDepartmentId.value = null
  departmentRenameDraft.value = ''
}

async function saveDepartmentName(department: AdminDepartment) {
  const name = departmentRenameDraft.value.trim()
  if (!name) { departmentError.value = '请输入部门名称'; return }
  savingDepartment.value = department.id; departmentError.value = ''
  try {
    const saved = await updateAdminDepartment(department.id, { name })
    departments.value = departments.value.map((item) => item.id === department.id ? saved : item)
    renamingDepartmentId.value = null
    departmentRenameDraft.value = ''
  }
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
  const name = departmentDraft.value.name.trim()
  if (!name) { departmentError.value = '请输入部门名称'; return }
  creatingDepartment.value = true; departmentError.value = ''
  try { departments.value = [await createAdminDepartment({ name }), ...departments.value]; departmentDraft.value = { name: '' } }
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
          <tr v-for="user in users" :key="user.id"><td><strong>{{ user.displayName }}</strong><br><small>{{ user.email }}</small></td><td><select v-model="user.role" aria-label="用户角色"><option v-for="role in roles" :key="role.id" :value="role.code">{{ role.name }}</option></select></td><td><select v-model="user.departmentCode" aria-label="用户部门"><option :value="null">未分配</option><option v-for="department in departments" :key="department.id" :value="department.code">{{ department.name }}</option></select></td><td><label><input v-model="user.isActive" type="checkbox" /> 启用</label></td><td><button class="btn btn-primary" type="button" :disabled="savingUser === user.id" @click="saveUser(user)">{{ savingUser === user.id ? '保存中...' : '保存' }}</button></td></tr>
          <tr v-if="!users.length"><td colspan="5" class="table-empty">暂无用户</td></tr>
        </tbody></table>
      </div>
    </section>

    <section class="section">
      <div class="section-heading">
        <div><h3 class="section-title">部门管理</h3><p class="muted">停用后部门不再出现在新建需求的下拉选项中，历史记录仍保留；已无关联记录的部门可以直接删除。</p></div>
        <div class="inline-actions"><input v-model="departmentDraft.name" class="text-input" placeholder="新部门名称" aria-label="部门名称" @keyup.enter="addDepartment" /><button class="btn btn-primary" type="button" :disabled="creatingDepartment" @click="addDepartment">{{ creatingDepartment ? '新增中...' : '新增部门' }}</button></div>
      </div>
      <p v-if="notice" class="muted dept-code-hint" role="status">{{ notice }}</p>
      <p v-if="departmentError" class="error-note" role="alert">{{ departmentError }}</p>
      <div class="table-wrap"><table><thead><tr><th>部门名称</th><th>状态</th><th class="col-actions">操作</th></tr></thead><tbody>
        <tr v-for="department in departments" :key="department.id">
          <td>
            <input v-if="renamingDepartmentId === department.id" v-model="departmentRenameDraft" class="text-input dept-rename-input" aria-label="部门新名称" @keyup.enter="saveDepartmentName(department)" />
            <strong v-else>{{ department.name }}</strong>
          </td>
          <td>{{ department.isActive ? '启用' : '已停用' }}</td>
          <td class="row-actions">
            <template v-if="renamingDepartmentId === department.id">
              <button class="btn btn-primary" type="button" :disabled="savingDepartment === department.id" @click="saveDepartmentName(department)">{{ savingDepartment === department.id ? '保存中...' : '保存名称' }}</button>
              <button class="btn btn-ghost" type="button" :disabled="savingDepartment === department.id" @click="cancelRenameDepartment">取消</button>
            </template>
            <template v-else>
              <button class="btn btn-ghost" type="button" :disabled="savingDepartment === department.id" @click="startRenameDepartment(department)">重命名</button>
              <button class="btn btn-ghost" type="button" :disabled="savingDepartment === department.id" @click="toggleDepartment(department)">{{ department.isActive ? '停用' : '启用' }}</button>
              <span v-if="confirmingDepartmentId === department.id" class="confirm-actions">
                <button class="btn btn-danger" type="button" :disabled="savingDepartment === department.id" @click="removeDepartment(department)">{{ savingDepartment === department.id ? '删除中...' : '确认删除' }}</button>
                <button class="btn btn-ghost" type="button" :disabled="savingDepartment === department.id" @click="cancelRemoveDepartment">取消</button>
              </span>
              <button v-else class="btn btn-danger" type="button" :disabled="savingDepartment === department.id" @click="askRemoveDepartment(department)">删除</button>
            </template>
          </td>
        </tr>
        <tr v-if="!departments.length"><td colspan="3" class="table-empty">暂无部门</td></tr>
      </tbody></table></div>
    </section>

    <section class="section">
      <div class="section-heading">
        <div><h3 class="section-title">系统设置</h3></div>
        <button v-if="hasSettings" class="btn btn-primary" type="button" :disabled="savingSettings" @click="saveSettings">{{ savingSettings ? '保存中...' : '保存设置' }}</button>
      </div>
      <div v-if="hasSettings" class="form-grid form-panel">
        <div v-for="(_, key) in settingsDraft" :key="key" class="form-field">
          <label :for="`setting-${key}`">{{ key }}</label>
          <input :id="`setting-${key}`" v-model="settingsDraft[key]" />
        </div>
      </div>
      <p v-else class="settings-empty">当前没有可编辑的系统设置项。</p>
      <div class="settings-row">
        <div><strong>简历病毒扫描</strong><p>开启后，新上传简历会先进入隔离区并由 ClamAV 扫描；默认关闭。</p></div>
        <label class="switch">
          <input type="checkbox" v-model="resumeVirusScanEnabled" :disabled="savingResumeVirusScan" @change="saveResumeVirusScan" />
          <span class="switch-track" aria-hidden="true"></span>
          <span class="switch-label">{{ resumeVirusScanEnabled ? '已开启' : '已关闭' }}</span>
        </label>
      </div>
    </section>

    <section class="section">
      <div class="section-heading">
        <div><h3 class="section-title">AI 模型</h3><p class="muted">保存后写入 <code>ENV_FILE_PATH</code> 指定的 .env 文件，并立即对当前 API 进程生效。密钥为写入专用，保存后不再回显。</p></div>
        <div class="inline-actions">
          <button class="btn btn-primary" type="button" :disabled="savingAiSettings" @click="submitAiSettings">{{ savingAiSettings ? '保存中...' : '保存模型配置' }}</button>
          <button class="btn btn-ghost" type="button" :disabled="testingAiConnection" @click="runAiConnectionTest">{{ testingAiConnection ? '测试中...' : '测试连接' }}</button>
          <template v-if="aiSettings?.env.OPENAI_API_KEY.configured">
            <button v-if="!confirmingAiKeyClear" class="btn btn-ghost" type="button" :disabled="savingAiSettings" @click="confirmingAiKeyClear = true">清除密钥</button>
            <template v-else>
              <button class="btn btn-danger" type="button" :disabled="savingAiSettings" @click="clearAiApiKey">{{ savingAiSettings ? '清除中...' : '确认清除密钥' }}</button>
              <button class="btn btn-ghost" type="button" :disabled="savingAiSettings" @click="confirmingAiKeyClear = false">取消</button>
            </template>
          </template>
        </div>
      </div>
      <div v-if="aiSettings" class="form-panel">
        <div class="form-grid ai-grid">
          <div class="form-field"><label for="ai-base-url">接口地址</label><input id="ai-base-url" v-model="aiDraft.baseUrl" placeholder="https://api.deepseek.com/v1" /></div>
          <div class="form-field">
            <label for="ai-api-key">API 密钥</label>
            <input id="ai-api-key" v-model="aiDraft.apiKey" type="password" :placeholder="aiSettings.env.OPENAI_API_KEY.configured ? '已配置，留空表示不修改' : '请输入 API 密钥'" autocomplete="new-password" />
          </div>
          <div class="form-field">
            <label for="ai-model">模型</label>
            <select id="ai-model" v-model="aiDraft.model">
              <option value="" disabled>{{ aiModelOptions.length ? '请选择模型' : '点击测试连接获取模型列表' }}</option>
              <option v-for="model in aiModelOptions" :key="model" :value="model">{{ model }}</option>
            </select>
          </div>
          <div class="form-field"><label for="ai-timeout">超时（毫秒）</label><input id="ai-timeout" v-model="aiDraft.timeoutMs" placeholder="30000" /></div>
        </div>
        <p v-if="aiTestResult" :class="aiTestResult.ok ? 'muted' : 'error-note'">{{ aiTestResult.message }}（{{ aiTestResult.latencyMs }} 毫秒）</p>
      </div>
      <div v-else class="table-empty">正在读取模型配置...</div>
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
      <h3 class="section-title">失败分析任务</h3><div class="table-wrap"><table><thead><tr><th>重试次数</th><th>错误</th><th>创建时间</th></tr></thead><tbody>
        <tr v-for="task in failedTasks" :key="task.id"><td>{{ task.attempts }}</td><td>{{ task.lastError || '—' }}</td><td>{{ new Date(task.createdAt).toLocaleString() }}</td></tr><tr v-if="!failedTasks.length"><td colspan="3" class="table-empty">暂无失败任务</td></tr>
      </tbody></table></div>
    </section>

    <section class="section">
      <h3 class="section-title">管理审计日志</h3><div class="table-wrap"><table><thead><tr><th>时间</th><th>操作</th><th>操作人</th></tr></thead><tbody>
        <tr v-for="log in auditLogs" :key="log.id"><td>{{ new Date(log.createdAt).toLocaleString() }}</td><td>{{ actionLabel(log.action) }}</td><td>{{ log.actorEmail || '—' }}</td></tr><tr v-if="!auditLogs.length"><td colspan="3" class="table-empty">暂无管理审计日志</td></tr>
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
              <td>{{ actionLabel(event.action) }}</td>
              <td>{{ statusLabel(event.fromStatus) }} → {{ statusLabel(event.toStatus) }}</td>
              <td>{{ event.actorName || '系统' }}</td>
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
.row-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.confirm-actions { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
.dept-code-hint { margin: 0 0 12px; font-size: 12.5px; color: var(--muted, #64748b); }
.dept-code-hint.is-invalid { color: #b91c1c; }
.col-actions { width: 320px; }
.text-input { border: 1px solid #cbd5e1; border-radius: 7px; padding: 7px 10px; font-size: 12.5px; color: #1e293b; background: #fff; outline: none; }
.text-input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-bg); }
.dept-rename-input { width: 100%; max-width: 240px; }
.settings-empty { margin: 0 0 10px; font-size: 12.5px; color: var(--muted, #64748b); }
.settings-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; background: #fff; border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.settings-row strong { font-size: 13px; color: #1e293b; }
.settings-row p { margin: 4px 0 0; font-size: 12px; color: var(--muted, #64748b); }
.switch { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: #334155; cursor: pointer; white-space: nowrap; }
.switch input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.switch-track { position: relative; flex: none; width: 36px; height: 20px; border-radius: 999px; background: #cbd5e1; transition: background .15s ease; }
.switch-track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s ease; }
.switch input:checked + .switch-track { background: var(--primary); }
.switch input:checked + .switch-track::after { transform: translateX(16px); }
.switch input:disabled + .switch-track { opacity: .6; }
.switch-label { min-width: 42px; }
.btn-sm { padding: 4px 8px; font-size: 11.5px; }
.form-field small .btn + .btn { margin-left: 6px; }
.ai-grid { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 0.7fr); }
@media (max-width: 1180px) { .ai-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { .ai-grid { grid-template-columns: 1fr; } }
</style>
