<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { listAdminChecks, loadWorkflowEvents, listAdminUsers, listAdminRoles, listAdminDepartments, createAdminDepartment, updateAdminDepartment, deleteAdminDepartment, getAdminSettings, updateAdminSettings, getDingTalkSettings, updateDingTalkSettings, getResumeVirusScanSetting, updateResumeVirusScanSetting, getAiSettings, saveAiSettings, testAiConnection, listFailedAnalysisTasks, listAdminAuditLogs, updateAdminUser, listAiPromptSkills, createAiPromptSkill, updateAiPromptSkill, deleteAiPromptSkill, type AdminCheckRow, type WorkflowEvent, type AdminUser, type AdminRole, type AdminDepartment, type AdminSettings, type DingTalkEnvSettings, type AiSettings, type AiConnectionTestResult, type AdminAnalysisTask, type AdminAuditLog, type AdminAiPromptSkill, type AiPromptSkillTarget } from '../api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import SecurityNotice from '../components/SecurityNotice.vue'
import ChannelIntegrationSettings from '../components/ChannelIntegrationSettings.vue'
import { actionLabel, statusLabel } from '../../../shared/utils/labels'
import { formatAnalysisError } from '../../../shared/utils/analysis-error'
import { administrationModules, isAdministrationModuleKey, type AdministrationModuleKey } from '../moduleConfig'

const route = useRoute()
const router = useRouter()
const routeQuery = computed(() => route?.query ?? {})

const activeModule = computed<AdministrationModuleKey>(() => {
  const value = Array.isArray(routeQuery.value.module) ? routeQuery.value.module[0] : routeQuery.value.module
  return isAdministrationModuleKey(value) ? value : 'users'
})
const activeModuleLabel = computed(() => administrationModules.find((module) => module.key === activeModule.value)?.label ?? '用户与角色')

function selectModule(value: string) {
  if (!isAdministrationModuleKey(value)) return
  router?.push({ path: '/administration', query: { ...routeQuery.value, module: value } })
}

watch(() => routeQuery.value.module, (value) => {
  if (value !== undefined && !isAdministrationModuleKey(Array.isArray(value) ? value[0] : value)) {
    router?.replace({ path: '/administration', query: { ...routeQuery.value, module: 'users' } })
  }
})

const rows = ref<AdminCheckRow[]>([])
const events = ref<WorkflowEvent[]>([])
const eventsPage = ref(1)
const eventsPageSize = ref(20)
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
const auditPage = ref(1)
const auditPageSize = ref(10)
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
const aiSettingsUnavailable = ref(false)
const aiSkills = ref<AdminAiPromptSkill[]>([])
const aiSkillDraft = ref({ name: '', targetType: 'both' as AiPromptSkillTarget, content: '' })
const editingAiSkillId = ref<string | null>(null)
const savingAiSkill = ref(false)
const deletingAiSkillId = ref<string | null>(null)
const aiSkillsError = ref('')
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

const auditTotalPages = computed(() => Math.max(1, Math.ceil(auditLogs.value.length / auditPageSize.value)))
const pagedAuditLogs = computed(() => {
  const start = (auditPage.value - 1) * auditPageSize.value
  return auditLogs.value.slice(start, start + auditPageSize.value)
})
const eventsTotalPages = computed(() => Math.max(1, Math.ceil(events.value.length / eventsPageSize.value)))
const pagedEvents = computed(() => {
  const start = (eventsPage.value - 1) * eventsPageSize.value
  return events.value.slice(start, start + eventsPageSize.value)
})

const hasSettings = computed(() => Object.keys(settingsDraft.value).length > 0)

function subjectName(event: WorkflowEvent) {
  return event.subjectLabel || event.subjectId
}

async function refresh() {
  loading.value = true
  error.value = ''
  departmentError.value = ''
  aiSettingsUnavailable.value = false

  // 系统配置由多个相互独立的模块组成。某个可选接口（例如旧 API 尚未提供
  // AI 或钉钉配置接口）失败时，不能让其它模块一起变成空白。
  const results = await Promise.allSettled([
    listAdminChecks(),
    loadWorkflowEvents(subjectType.value || undefined, 80),
    listAdminUsers(),
    listAdminRoles(),
    listAdminDepartments(),
    getAdminSettings(),
    getDingTalkSettings(),
    getResumeVirusScanSetting(),
    getAiSettings(),
    listFailedAnalysisTasks(),
    listAdminAuditLogs(80),
    listAiPromptSkills(),
  ])

  const failures: string[] = []
  const read = <T>(index: number, label: string): T | undefined => {
    const result = results[index]
    if (result?.status === 'fulfilled') return result.value as T
    const cause = result?.status === 'rejected' ? result.reason : undefined
    failures.push(`${label}：${cause instanceof Error ? cause.message : '暂时无法读取'}`)
    return undefined
  }

  const checks = read<AdminCheckRow[]>(0, '系统运行检查')
  const audit = read<WorkflowEvent[]>(1, '流程审计记录')
  const adminUsers = read<AdminUser[]>(2, '用户')
  const adminRoles = read<AdminRole[]>(3, '角色')
  const adminDepartments = read<AdminDepartment[]>(4, '部门')
  const adminSettings = read<AdminSettings>(5, '系统设置')
  const adminDingTalkSettings = read<DingTalkEnvSettings>(6, '钉钉配置')
  const adminVirusScan = read<{ enabled: boolean }>(7, '简历病毒扫描设置')
  const aiConfig = read<AiSettings>(8, 'AI 模型配置')
  const tasks = read<AdminAnalysisTask[]>(9, '失败分析任务')
  const logs = read<AdminAuditLog[]>(10, '管理审计日志')
  const skills = results[11]?.status === 'fulfilled' ? results[11].value as AdminAiPromptSkill[] : undefined
  if (results[11]?.status === 'rejected') aiSkillsError.value = results[11].reason instanceof Error ? results[11].reason.message : '暂时无法读取 Skill'
  else aiSkillsError.value = ''

  if (checks) rows.value = checks
  if (audit) { events.value = audit; eventsPage.value = 1 }
  if (adminUsers) users.value = adminUsers
  if (adminRoles) roles.value = adminRoles
  if (adminDepartments) departments.value = adminDepartments
  if (adminSettings) {
    settings.value = adminSettings
    settingsDraft.value = Object.fromEntries(Object.entries(adminSettings).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]))
  }
  if (adminDingTalkSettings) {
    dingTalkSettings.value = adminDingTalkSettings
    dingTalkDraft.value = Object.fromEntries(dingTalkFields.map(({ key }) => [key, '']))
  }
  if (adminVirusScan) resumeVirusScanEnabled.value = adminVirusScan.enabled
  if (aiConfig) applyAiSettings(aiConfig)
  else if (results[8]?.status === 'rejected') aiSettingsUnavailable.value = true
  if (tasks) failedTasks.value = tasks
  if (logs) { auditLogs.value = logs; auditPage.value = 1 }
  if (skills) aiSkills.value = skills

  if (failures.length) {
    error.value = `部分系统配置暂时无法读取：${failures.join('；')}`
  }
  loading.value = false
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

function resetAiSkillDraft() {
  aiSkillDraft.value = { name: '', targetType: 'both', content: '' }
  editingAiSkillId.value = null
}

function editAiSkill(skill: AdminAiPromptSkill) {
  editingAiSkillId.value = skill.id
  aiSkillDraft.value = { name: skill.name, targetType: skill.targetType, content: skill.content }
  aiSkillsError.value = ''
}

async function saveAiSkill() {
  const name = aiSkillDraft.value.name.trim()
  const content = aiSkillDraft.value.content.trim()
  if (!name || !content) { aiSkillsError.value = '请输入 Skill 名称和内容'; return }
  savingAiSkill.value = true
  aiSkillsError.value = ''
  try {
    const saved = editingAiSkillId.value
      ? await updateAiPromptSkill(editingAiSkillId.value, { name, targetType: aiSkillDraft.value.targetType, content })
      : await createAiPromptSkill({ name, targetType: aiSkillDraft.value.targetType, content })
    aiSkills.value = editingAiSkillId.value
      ? aiSkills.value.map((item) => item.id === saved.id ? saved : item)
      : [saved, ...aiSkills.value]
    resetAiSkillDraft()
  } catch (cause) { aiSkillsError.value = cause instanceof Error ? cause.message : '保存 Skill 失败' }
  finally { savingAiSkill.value = false }
}

async function toggleAiSkill(skill: AdminAiPromptSkill) {
  savingAiSkill.value = true
  aiSkillsError.value = ''
  try {
    const saved = await updateAiPromptSkill(skill.id, { isActive: !skill.isActive })
    aiSkills.value = aiSkills.value.map((item) => item.id === saved.id ? saved : item)
  } catch (cause) { aiSkillsError.value = cause instanceof Error ? cause.message : '更新 Skill 状态失败' }
  finally { savingAiSkill.value = false }
}

async function removeAiSkill(skill: AdminAiPromptSkill) {
  deletingAiSkillId.value = skill.id
  aiSkillsError.value = ''
  try {
    await deleteAiPromptSkill(skill.id)
    aiSkills.value = aiSkills.value.filter((item) => item.id !== skill.id)
    if (editingAiSkillId.value === skill.id) resetAiSkillDraft()
  } catch (cause) { aiSkillsError.value = cause instanceof Error ? cause.message : '删除 Skill 失败' }
  finally { deletingAiSkillId.value = null }
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
  <div class="module-toolbar" aria-label="系统配置模块选择">
    <div>
      <span class="module-toolbar-eyebrow">当前配置模块</span>
      <strong>{{ activeModuleLabel }}</strong>
    </div>
    <label class="module-select-label">
      <span>切换模块</span>
      <select :value="activeModule" aria-label="切换系统配置模块" @change="selectModule(($event.target as HTMLSelectElement).value)">
        <option v-for="module in administrationModules" :key="module.key" :value="module.key">{{ module.label }}</option>
      </select>
    </label>
  </div>
  <div v-if="loading" class="loading-note">正在读取系统配置与审计记录...</div>
  <div v-else>
    <div v-if="error" class="error-note" role="alert">{{ error }} <button class="btn btn-ghost" type="button" @click="refresh">重试</button></div>
    <section v-if="activeModule === 'users'" class="section">
      <h3 class="section-title">用户与角色</h3>
      <div class="table-wrap">
        <table><thead><tr><th>用户</th><th>角色</th><th>部门</th><th>状态</th><th>操作</th></tr></thead><tbody>
          <tr v-for="user in users" :key="user.id"><td><strong>{{ user.displayName }}</strong><br><small>{{ user.email }}</small></td><td><select v-model="user.role" aria-label="用户角色"><option v-for="role in roles" :key="role.id" :value="role.code">{{ role.name }}</option></select></td><td><select v-model="user.departmentCode" aria-label="用户部门"><option :value="null">未分配</option><option v-for="department in departments" :key="department.id" :value="department.code">{{ department.name }}</option></select></td><td><label><input v-model="user.isActive" type="checkbox" /> 启用</label></td><td><button class="btn btn-primary" type="button" :disabled="savingUser === user.id" @click="saveUser(user)">{{ savingUser === user.id ? '保存中...' : '保存' }}</button></td></tr>
          <tr v-if="!users.length"><td colspan="5" class="table-empty">暂无用户</td></tr>
        </tbody></table>
      </div>
    </section>

    <section v-else-if="activeModule === 'departments'" class="section">
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

    <section v-else-if="activeModule === 'settings'" class="section">
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

    <section v-else-if="activeModule === 'ai'" class="section">
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
      <div v-else-if="aiSettingsUnavailable" class="error-note">无法读取模型配置：后端未提供该接口，通常是 API 还在运行旧构建。请在服务器上重新构建并重启 API。</div>
      <div v-else class="table-empty">正在读取模型配置...</div>
    <div class="ai-skills-panel">
      <div class="section-heading">
        <div>
          <h3 class="section-title">岗位文档生成 Skill</h3>
          <p class="muted">把常用的写作规则保存为 Skill，生成岗位说明书或 JD 时可以直接选择复用。</p>
        </div>
        <button v-if="editingAiSkillId" class="btn btn-ghost" type="button" @click="resetAiSkillDraft">新建 Skill</button>
      </div>

      <div v-if="aiSkillsError" class="error-note" role="alert">{{ aiSkillsError }}</div>

      <div class="form-panel ai-skill-editor">
        <div class="form-grid ai-skill-editor-grid">
          <div class="form-field">
            <label for="ai-skill-name">Skill 名称</label>
            <input id="ai-skill-name" v-model="aiSkillDraft.name" maxlength="80" placeholder="例如：专业简洁型 JD" />
          </div>
          <div class="form-field">
            <label for="ai-skill-target">适用范围</label>
            <select id="ai-skill-target" v-model="aiSkillDraft.targetType">
              <option value="both">岗位说明书和 JD</option>
              <option value="job_spec">仅岗位说明书</option>
              <option value="jd">仅 JD</option>
            </select>
          </div>
        </div>
        <div class="form-field">
          <label for="ai-skill-content">Skill 内容</label>
          <textarea id="ai-skill-content" v-model="aiSkillDraft.content" rows="5" maxlength="8000" placeholder="例如：使用专业、清晰、可执行的语言；职责按重要性排序；避免空泛形容词；尽量补充可衡量的结果指标。"></textarea>
          <small class="muted">把你希望模型长期遵循的写作风格、结构和限制写在这里，最多 8000 个字符。</small>
        </div>
        <div class="inline-actions">
          <button class="btn btn-primary" type="button" :disabled="savingAiSkill" @click="saveAiSkill">{{ savingAiSkill ? '保存中...' : (editingAiSkillId ? '保存修改' : '创建 Skill') }}</button>
          <button v-if="editingAiSkillId" class="btn btn-ghost" type="button" :disabled="savingAiSkill" @click="resetAiSkillDraft">取消编辑</button>
        </div>
      </div>

      <div class="table-wrap ai-skills-table">
        <table>
          <thead><tr><th>名称</th><th>适用范围</th><th>状态</th><th>内容</th><th class="col-actions">操作</th></tr></thead>
          <tbody>
            <tr v-for="skill in aiSkills" :key="skill.id">
              <td><strong>{{ skill.name }}</strong></td>
              <td>{{ skill.targetType === 'both' ? '岗位说明书和 JD' : skill.targetType === 'job_spec' ? '仅岗位说明书' : '仅 JD' }}</td>
              <td><span :class="skill.isActive ? 'skill-status active' : 'skill-status'">{{ skill.isActive ? '启用' : '停用' }}</span></td>
              <td><span class="skill-content-preview">{{ skill.content }}</span></td>
              <td class="row-actions">
                <button class="btn btn-ghost btn-sm" type="button" @click="editAiSkill(skill)">编辑</button>
                <button class="btn btn-ghost btn-sm" type="button" :disabled="savingAiSkill" @click="toggleAiSkill(skill)">{{ skill.isActive ? '停用' : '启用' }}</button>
                <button class="btn btn-danger btn-sm" type="button" :disabled="deletingAiSkillId === skill.id" @click="removeAiSkill(skill)">{{ deletingAiSkillId === skill.id ? '删除中...' : '删除' }}</button>
              </td>
            </tr>
            <tr v-if="!aiSkills.length"><td colspan="5" class="table-empty">暂无 Skill，请先创建一个可复用的生成规则。</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    </section>

    <section v-else-if="activeModule === 'dingtalk'" class="section">
      <div class="section-heading"><div><h3 class="section-title">钉钉集成配置</h3><p class="muted">保存后写入 <code>ENV_FILE_PATH</code> 指定的 .env 文件，并立即对当前 API 进程生效。</p></div><button class="btn btn-primary" type="button" :disabled="savingDingTalk" @click="saveDingTalkSettings">{{ savingDingTalk ? '保存中...' : '保存钉钉配置' }}</button></div>
      <div class="form-grid form-panel">
        <div v-for="field in dingTalkFields" :key="field.key" class="form-field">
          <label :for="`dingtalk-${field.key}`">{{ field.label }} <code>{{ field.key }}</code></label>
          <input :id="`dingtalk-${field.key}`" v-model="dingTalkDraft[field.key]" :type="field.secret ? 'password' : 'text'" :placeholder="dingTalkSettings[field.key]?.configured ? '已配置，留空表示不修改' : '未配置'" autocomplete="new-password" />
          <small>{{ field.help }} <a :href="field.href" target="_blank" rel="noreferrer">查看钉钉官方文档</a></small>
        </div>
      </div>
    </section>

    <div v-else-if="activeModule === 'channels'"><ChannelIntegrationSettings /></div>

    <section v-else-if="activeModule === 'failed-tasks'" class="section">
      <h3 class="section-title">失败分析任务</h3><div class="table-wrap"><table><thead><tr><th>重试次数</th><th>错误</th><th>创建时间</th></tr></thead><tbody>
        <tr v-for="task in failedTasks" :key="task.id"><td>{{ task.attempts }}</td><td>{{ formatAnalysisError(task.lastError) }}</td><td>{{ new Date(task.createdAt).toLocaleString() }}</td></tr><tr v-if="!failedTasks.length"><td colspan="3" class="table-empty">暂无失败任务</td></tr>
      </tbody></table></div>
    </section>

    <section v-else-if="activeModule === 'audit-logs'" class="section">
      <div class="section-heading">
        <h3 class="section-title">管理审计日志</h3>
        <label class="page-size">
          <span>每页</span>
          <select v-model.number="auditPageSize" @change="auditPage = 1">
            <option :value="10">10 条</option>
            <option :value="20">20 条</option>
            <option :value="50">50 条</option>
          </select>
        </label>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>时间</th><th>操作</th><th>操作人</th></tr></thead>
          <tbody>
            <tr v-for="log in pagedAuditLogs" :key="log.id"><td>{{ new Date(log.createdAt).toLocaleString() }}</td><td>{{ actionLabel(log.action) }}</td><td>{{ log.actorEmail || '—' }}</td></tr>
            <tr v-if="!auditLogs.length"><td colspan="3" class="table-empty">暂无管理审计日志</td></tr>
          </tbody>
        </table>
      </div>
      <div v-if="auditLogs.length" class="pagination-bar">
        <span>共 {{ auditLogs.length }} 条，第 {{ auditPage }} / {{ auditTotalPages }} 页</span>
        <div class="inline-actions">
          <button class="btn btn-ghost btn-sm" type="button" :disabled="auditPage <= 1" @click="auditPage -= 1">上一页</button>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="auditPage >= auditTotalPages" @click="auditPage += 1">下一页</button>
        </div>
      </div>
    </section>

    <section v-else-if="activeModule === 'health'" class="section">
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

    <section v-else-if="activeModule === 'workflow-audit'" class="section">
      <div class="section-heading">
        <h3 class="section-title">流程审计记录</h3>
        <div class="inline-actions">
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
          <label class="page-size">
            <span>每页</span>
            <select v-model.number="eventsPageSize" @change="eventsPage = 1">
              <option :value="10">10 条</option>
              <option :value="20">20 条</option>
              <option :value="50">50 条</option>
            </select>
          </label>
        </div>
      </div>
      <div v-if="eventSummary.length" class="audit-summary">
        <span v-for="item in eventSummary" :key="item.type" class="audit-chip">{{ item.label }} · {{ item.count }}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>时间</th><th>实体类型</th><th>对象</th><th>动作</th><th>状态流转</th><th>操作人</th><th>原因</th></tr></thead>
          <tbody>
            <tr v-for="event in pagedEvents" :key="event.id">
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
      <div v-if="events.length" class="pagination-bar">
        <span>共 {{ events.length }} 条，第 {{ eventsPage }} / {{ eventsTotalPages }} 页</span>
        <div class="inline-actions">
          <button class="btn btn-ghost btn-sm" type="button" :disabled="eventsPage <= 1" @click="eventsPage -= 1">上一页</button>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="eventsPage >= eventsTotalPages" @click="eventsPage += 1">下一页</button>
        </div>
      </div>
    </section>

    <section v-else-if="activeModule === 'security'" class="section security-section">
      <h3 class="section-title">安全提示</h3>
      <SecurityNotice />
    </section>
  </div>
</template>

<style scoped>
.module-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 0 0 16px;
  padding: 14px 16px;
  border: 1px solid #dcecf0;
  border-radius: 16px;
  background: linear-gradient(120deg, #f7fcfb 0%, #f4f8ff 100%);
  box-shadow: 0 8px 22px rgba(78, 137, 157, .07);
}
.module-toolbar-eyebrow { display: block; margin-bottom: 4px; color: #8aa4b2; font-size: 11px; }
.module-toolbar strong { color: #24445b; font-size: 16px; }
.module-select-label { display: inline-flex; align-items: center; gap: 9px; color: #7890a4; font-size: 12px; }
.module-select-label select { min-width: 170px; border: 1px solid #cfe2eb; border-radius: 10px; padding: 8px 32px 8px 11px; background: rgba(255,255,255,.86); color: #31536d; outline: none; }
.module-select-label select:focus { border-color: #79c7bb; box-shadow: 0 0 0 3px rgba(121, 199, 187, .16); }
.security-section :deep(.security-note) { margin-top: 0; }
@media (max-width: 700px) {
  .module-toolbar { align-items: flex-start; flex-direction: column; }
  .module-select-label { width: 100%; justify-content: space-between; }
  .module-select-label select { flex: 1; min-width: 0; }
}
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.page-size { display: inline-flex; align-items: center; gap: 7px; color: var(--muted, #64748b); font-size: 12px; }
.page-size select { border: 1px solid #cbd5e1; border-radius: 7px; padding: 6px 9px; background: #fff; color: #334155; }
.pagination-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; color: var(--muted, #64748b); font-size: 12px; }
.btn-sm { padding: 4px 8px; font-size: 11.5px; }
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

.ai-skills-panel { margin-top: 18px; padding-top: 18px; border-top: 1px solid #e5eef2; }
.ai-skill-editor { margin-top: 12px; }
.ai-skill-editor-grid { grid-template-columns: minmax(0, 1.4fr) minmax(220px, .8fr); }
.ai-skill-editor textarea { width: 100%; min-height: 116px; resize: vertical; }
.ai-skills-table { margin-top: 14px; }
.skill-status { display: inline-flex; padding: 3px 8px; border-radius: 999px; background: #f1f5f9; color: #64748b; font-size: 12px; }
.skill-status.active { background: #dcfce7; color: #166534; }
.skill-content-preview { display: -webkit-box; overflow: hidden; max-width: 360px; color: #64748b; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
@media (max-width: 760px) { .ai-skill-editor-grid { grid-template-columns: 1fr; } .ai-skills-table { overflow-x: auto; } }
</style>
