<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, KeyRound, LogOut, PencilLine, ShieldCheck, ShieldOff, X } from '@lucide/vue'
import { appointWorkspaceOwner, updatePlatformWorkspaceAiAccess, type PlatformUserDetail } from '../api'
import { describeApiFailure } from '../../../../shared/utils/errorMessage'

const props = defineProps<{
  detail: PlatformUserDetail | null
  loading: boolean
  error: string
  canWrite: boolean
}>()

const emit = defineEmits<{
  close: []
  action: [kind: 'status' | 'revoke' | 'reset' | 'profile', workspaceId?: string]
  'update:detail': [detail: PlatformUserDetail, workspaceId: string]
}>()

const appointingOwner = ref(false)
const tab = ref<'overview' | 'workspaces' | 'security' | 'audit'>('overview')
type AiEdit = { value: boolean; reason: string; saving: boolean; error: string }
const aiEdits = ref<Record<string, AiEdit>>({})
const initial = computed(() => props.detail?.user.displayName.slice(0, 1) || '用')
const sourceLabels: Record<string, string> = {
  open_registration: '开放注册',
  platform_created: '平台创建',
  legacy: '历史账号',
}
const roleLabels: Record<string, string> = {
  owner: '企业所有者',
  admin: '企业管理员',
  member: '普通成员',
}
const serviceLabels: Record<string, string> = {
  enabled: '已启用',
  trial: '试用中',
  suspended: '已暂停',
}

function time(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}

function auditReason(metadata: Record<string, unknown>) {
  const reason = metadata.reason
  return typeof reason === 'string' && reason ? reason : '—'
}

watch(() => props.detail?.user.id, () => { aiEdits.value = {} })

function beginAiEdit(workspaceId: string, value: boolean) {
  if (!props.canWrite) return
  aiEdits.value[workspaceId] = { value: !value, reason: '', saving: false, error: '' }
}

async function appointOwner(workspaceId: string) {
  const userId = props.detail?.user.id
  if (!userId || !props.canWrite || appointingOwner.value) return
  const reason = window.prompt('指定此用户为企业主管理员后，原主管理员将成为普通成员。请填写原因')
  if (!reason || reason.trim().length < 2 || reason.trim().length > 500) return
  appointingOwner.value = true
  try {
    const updated = await appointWorkspaceOwner(userId, workspaceId, reason.trim())
    emit('update:detail', updated, workspaceId)
  } catch (cause) { window.alert(describeApiFailure(cause, '指定主管理员失败').message) }
  finally { appointingOwner.value = false }
}

async function saveAiAccess(workspaceId: string) {
  const edit = aiEdits.value[workspaceId]
  const userId = props.detail?.user.id
  if (!userId || !props.canWrite || !edit || edit.reason.trim().length < 2 || edit.reason.trim().length > 500 || edit.saving) return
  edit.saving = true
  edit.error = ''
  try {
    const updated = await updatePlatformWorkspaceAiAccess(userId, workspaceId, edit.value, edit.reason.trim())
    emit('update:detail', updated, workspaceId)
    if (aiEdits.value[workspaceId] === edit) delete aiEdits.value[workspaceId]
  } catch (cause) {
    edit.error = describeApiFailure(cause, '保存 AI 模型使用权限失败').message
  } finally {
    edit.saving = false
  }
}
</script>

<template>
  <aside class="detail-drawer" aria-label="用户详情">
    <div v-if="loading" class="drawer-state" role="status">正在读取用户详情...</div>
    <div v-else-if="error" class="drawer-state error" role="alert">{{ error }}</div>
    <div v-else-if="!detail" class="drawer-state">
      <strong>选择一个用户</strong>
      <span>点击左侧列表中的用户，查看账号、企业归属、登录安全和操作记录。</span>
    </div>
    <template v-else>
      <header class="drawer-header">
        <div class="identity-row">
          <span class="avatar">{{ initial }}</span>
          <div>
            <h2>{{ detail.user.displayName }}</h2>
            <p>{{ detail.user.email }}</p>
          </div>
          <button class="icon-button" type="button" aria-label="关闭用户详情" @click="emit('close')"><X :size="16" /></button>
        </div>
        <div class="identity-tags">
          <span class="status-pill" :class="{ disabled: !detail.user.isActive }">{{ detail.user.isActive ? '启用' : '停用' }}</span>
          <span v-if="detail.user.platformRole" class="role-pill platform">{{ detail.user.platformRole === 'admin' ? '平台管理员' : '平台只读' }}</span>
          <span class="role-pill">{{ sourceLabels[detail.user.registrationSource] || detail.user.registrationSource }}</span>
        </div>
      </header>

      <nav class="tabs" aria-label="用户详情分类">
        <button :class="{ active: tab === 'overview' }" type="button" @click="tab = 'overview'">账号概览</button>
        <button :class="{ active: tab === 'workspaces' }" type="button" @click="tab = 'workspaces'">企业归属</button>
        <button :class="{ active: tab === 'security' }" type="button" @click="tab = 'security'">登录安全</button>
        <button :class="{ active: tab === 'audit' }" type="button" @click="tab = 'audit'">操作记录</button>
      </nav>

      <div class="drawer-body">
        <section v-if="tab === 'overview'" class="section">
          <div class="section-heading"><h3>基本信息</h3><span>账号 ID</span></div>
          <dl class="data-grid">
            <div><dt>用户 ID</dt><dd class="mono">{{ detail.user.id }}</dd></div>
            <div><dt>手机号</dt><dd>{{ detail.user.phone || '未填写' }}</dd></div>
            <div class="wide"><dt>登录邮箱</dt><dd>{{ detail.user.email }}</dd></div>
            <div><dt>注册时间</dt><dd>{{ time(detail.user.createdAt) }}</dd></div>
            <div><dt>最后登录</dt><dd>{{ time(detail.user.lastLoginAt) }}</dd></div>
          </dl>
          <div class="section-heading"><h3>当前状态</h3></div>
          <div class="state-grid">
            <div><span>账号状态</span><strong>{{ detail.user.isActive ? '可正常登录' : '禁止登录' }}</strong></div>
            <div><span>所属企业</span><strong>{{ detail.workspaces.length }} 家</strong></div>
            <div><span>活跃会话</span><strong>{{ detail.activeSessions.length }} 个</strong></div>
          </div>
        </section>

        <section v-else-if="tab === 'workspaces'" class="section">
          <div class="section-heading"><h3>企业归属</h3><span>{{ detail.workspaces.length }} 家</span></div>
          <article v-for="workspace in detail.workspaces" :key="workspace.id" class="workspace-item">
            <div class="workspace-title">
              <span class="company-mark">{{ workspace.name.slice(0, 1) }}</span>
              <div><strong>{{ workspace.name }}</strong><small>{{ workspace.kind === 'production' ? '正式企业' : '测试企业' }} · {{ serviceLabels[workspace.serviceStatus] }}</small></div>
              <span class="role-pill" :class="{ owner: workspace.membershipRole === 'owner' }">{{ roleLabels[workspace.membershipRole] }}</span>
            </div>
            <dl>
              <div><dt>账号类型</dt><dd>{{ workspace.businessRole }}</dd></div>
              <div><dt>部门</dt><dd>{{ workspace.departmentName || '未分配' }}</dd></div>
              <div><dt>加入时间</dt><dd>{{ time(workspace.joinedAt) }}</dd></div>
            </dl>
            <p v-if="workspace.isActive === false" class="ai-error">本企业成员已停用</p>
            <button v-if="canWrite && workspace.membershipRole !== 'owner' && workspace.isActive !== false && detail.user.isActive" class="ai-edit" type="button" :disabled="appointingOwner" @click="appointOwner(workspace.id)"><ShieldCheck :size="14" />指定为企业主管理员</button>
            <div class="ai-access-row">
              <label :for="`ai-access-${workspace.id}`">授权本企业使用平台模型</label>
              <span class="ai-access-state">{{ workspace.platformAiAccessReady === false ? '待启用' : workspace.usePlatformAi ? '已开启' : '已关闭' }}</span>
              <input :id="`ai-access-${workspace.id}`" class="ai-switch" type="checkbox" role="switch"
                :checked="aiEdits[workspace.id]?.value ?? workspace.usePlatformAi"
                :disabled="!canWrite || workspace.platformAiAccessReady === false || aiEdits[workspace.id]?.saving"
                @change="beginAiEdit(workspace.id, aiEdits[workspace.id]?.value ?? workspace.usePlatformAi)" />

            </div>
            <p v-if="workspace.usePlatformAi && !aiEdits[workspace.id]" class="ai-source">模型来源：平台统一配置</p>
            <form v-if="aiEdits[workspace.id]" class="ai-edit-form" @submit.prevent="saveAiAccess(workspace.id)">
              <p class="ai-source">{{ aiEdits[workspace.id]!.value ? '确认授权该企业使用平台统一模型？' : '确认撤回平台模型授权？' }} 本企业所有成员均受此设置影响。</p>
              <label class="ai-reason">操作原因<input v-model="aiEdits[workspace.id]!.reason" type="text" maxlength="500" required minlength="2" :disabled="aiEdits[workspace.id]!.saving" /></label>
              <div class="ai-form-actions">
                <button type="submit" :disabled="aiEdits[workspace.id]!.saving || aiEdits[workspace.id]!.reason.trim().length < 2"><Check :size="12" />{{ aiEdits[workspace.id]!.saving ? '保存中' : '确认' }}</button>
                <button type="button" :disabled="aiEdits[workspace.id]!.saving" @click="delete aiEdits[workspace.id]"><X :size="12" />取消</button>
              </div>
              <p v-if="aiEdits[workspace.id]!.error" class="ai-error" role="alert">{{ aiEdits[workspace.id]!.error }}</p>
            </form>
          </article>
          <div v-if="!detail.workspaces.length" class="empty-note">该账号尚未加入任何企业。</div>
        </section>

        <section v-else-if="tab === 'security'" class="section">
          <div class="section-heading"><h3>活跃会话</h3><span>{{ detail.activeSessions.length }} 个</span></div>
          <article v-for="session in detail.activeSessions" :key="session.id" class="session-item">
            <div><strong>{{ session.ipAddress || '未知 IP' }}</strong><span>{{ session.userAgent || '未知设备' }}</span></div>
            <small>最近活动 {{ time(session.lastSeenAt) }}</small>
          </article>
          <div v-if="!detail.activeSessions.length" class="empty-note">当前没有活跃会话。</div>
        </section>

        <section v-else class="section">
          <div class="section-heading"><h3>操作记录</h3><span>最近 {{ detail.recentAudit.length }} 条</span></div>
          <div class="audit-list">
            <article v-for="item in detail.recentAudit" :key="`${item.source}-${item.id}`">
              <span class="audit-dot"></span>
              <div><strong>{{ item.action }}</strong><p>{{ item.organizationName || '平台操作' }} · {{ time(item.createdAt) }}</p><small>原因：{{ auditReason(item.metadata) }}</small></div>
            </article>
          </div>
          <div v-if="!detail.recentAudit.length" class="empty-note">暂无与该账号相关的审计记录。</div>
        </section>

        <div class="privacy-note">
          <ShieldOff :size="16" />
          <span>平台视图仅用于账号支持和安全处置，不包含该用户的简历、面试录音、面试评价或 Offer 内容。</span>
        </div>
      </div>

      <footer class="drawer-actions">
        <button class="action-button" type="button" :disabled="!canWrite" @click="emit('action', 'profile')"><PencilLine :size="14" /> 编辑资料</button>
        <button class="action-button" type="button" :disabled="!canWrite" @click="emit('action', 'reset')"><KeyRound :size="14" /> 重置密码</button>
        <button class="action-button" type="button" :disabled="!canWrite" @click="emit('action', 'revoke')"><LogOut :size="14" /> 强制下线</button>
        <button class="action-button danger" type="button" :disabled="!canWrite" @click="emit('action', 'status')">{{ detail.user.isActive ? '停用账号' : '启用账号' }}</button>
      </footer>
    </template>
  </aside>
</template>

<style scoped>
.detail-drawer { display: flex; flex-direction: column; min-width: 0; min-height: 560px; border: 1px solid #dfe9e5; border-radius: 8px; background: #fff; overflow: hidden; }
.drawer-state { display: grid; place-content: center; gap: 8px; min-height: 560px; padding: 30px; color: #73837d; text-align: center; font-size: 12px; line-height: 1.65; }
.drawer-state strong { color: #30473f; font-size: 14px; }
.drawer-state.error { color: #b23d46; }
.drawer-header { padding: 18px 18px 14px; border-bottom: 1px solid #e3ebe8; }
.identity-row { display: flex; align-items: center; gap: 10px; }
.avatar { display: grid; place-items: center; flex: 0 0 42px; width: 42px; height: 42px; border-radius: 50%; background: #dfeee8; color: #2d6c56; font-size: 15px; font-weight: 760; }
.identity-row > div { flex: 1; min-width: 0; }
.identity-row h2 { margin: 0; color: #20372f; font-size: 16px; }
.identity-row p { overflow: hidden; margin: 4px 0 0; color: #75867f; font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.icon-button { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid #dce6e2; border-radius: 6px; background: #fff; color: #687a73; cursor: pointer; }
.identity-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.status-pill, .role-pill { display: inline-flex; align-items: center; min-height: 21px; padding: 0 8px; border-radius: 999px; background: #e8f5ef; color: #197053; font-size: 9.5px; font-weight: 700; }
.status-pill::before { content: ""; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: #26996b; }
.status-pill.disabled { background: #f9ecee; color: #a8464e; }
.status-pill.disabled::before { background: #b75a61; }
.role-pill { background: #eff3f1; color: #5d6e67; }
.role-pill.platform { background: #eeeafb; color: #65509b; }
.role-pill.owner { background: #fff1de; color: #8b5618; }
.tabs { display: flex; gap: 16px; padding: 0 18px; border-bottom: 1px solid #e3ebe8; overflow-x: auto; }
.tabs button { position: relative; flex: 0 0 auto; height: 40px; border: 0; background: transparent; color: #788981; font: inherit; font-size: 10.5px; font-weight: 650; cursor: pointer; }
.tabs button.active { color: #176d54; }
.tabs button.active::after { content: ""; position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; background: #177a5b; }
.drawer-body { flex: 1; max-height: 580px; padding: 16px 18px; overflow-y: auto; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 2px 0 9px; }
.section-heading h3 { margin: 0; color: #30443c; font-size: 10.5px; }
.section-heading span { color: #899791; font-size: 9px; }
.data-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; margin: 0 0 18px; overflow: hidden; border: 1px solid #e4ebe8; border-radius: 6px; background: #e4ebe8; }
.data-grid > div { min-width: 0; padding: 9px 10px; background: #fff; }
.data-grid .wide { grid-column: 1 / -1; }
.data-grid dt { margin-bottom: 4px; color: #82918b; font-size: 9px; }
.data-grid dd { overflow: hidden; margin: 0; color: #30443c; font-size: 10px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.state-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.state-grid > div { padding: 10px; border: 1px solid #e3ebe8; border-radius: 6px; background: #f9fbfa; }
.state-grid span, .state-grid strong { display: block; }
.state-grid span { color: #81918a; font-size: 9px; }
.state-grid strong { margin-top: 5px; color: #2d443b; font-size: 10.5px; }
.workspace-item { padding: 11px; border: 1px solid #e2eae7; border-radius: 6px; background: #fbfcfc; }
.workspace-item + .workspace-item { margin-top: 8px; }
.workspace-title { display: flex; align-items: center; gap: 8px; }
.company-mark { display: grid; place-items: center; flex: 0 0 24px; width: 24px; height: 24px; border-radius: 5px; background: #edf2f0; color: #557167; font-size: 10px; font-weight: 750; }
.workspace-title > div { flex: 1; min-width: 0; }
.workspace-title strong, .workspace-title small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-title strong { color: #2b4038; font-size: 10.5px; }
.workspace-title small { margin-top: 3px; color: #81918a; font-size: 9px; }
.workspace-item dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 10px 0 0; padding-top: 9px; border-top: 1px solid #e8eeeb; }
.workspace-item dt { color: #85948e; font-size: 8.5px; }
.workspace-item dd { margin: 3px 0 0; color: #41564e; font-size: 9.5px; }
.ai-access-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding-top: 9px; border-top: 1px solid #e8eeeb; color: #687b73; font-size: 9.5px; }
.ai-access-row > label { margin-right: auto; }
.quota-reset-button { display: inline-flex; align-items: center; gap: 4px; min-height: 27px; padding: 0 8px; border: 1px solid #e3cfc0; border-radius: 5px; background: #fffaf6; color: #9a5f2f; font: inherit; font-size: 9px; cursor: pointer; white-space: nowrap; }
.quota-reset-button:disabled { opacity: .55; cursor: not-allowed; }
.ai-access-state { color: #197053; font-weight: 700; }
.ai-access-row:has(.ai-switch:not(:checked)) .ai-access-state { color: #798781; }
.ai-error { color: #a8464e; }
.ai-edit, .ai-edit-form button { min-height: 27px; padding: 0 9px; border: 1px solid #d3dfda; border-radius: 5px; background: #fff; color: #3f5a50; font: inherit; font-size: 9px; cursor: pointer; }
.ai-edit-form { display: grid; gap: 8px; margin-top: 8px; }
.ai-form-actions { display: flex; gap: 6px; }
.ai-form-actions button { display: inline-flex; align-items: center; gap: 4px; }
.ai-reason { display: grid; gap: 4px; color: #687b73; font-size: 10px; }
.ai-source { margin: 6px 0 0; font-size: 10px; line-height: 1.6; color: #687b73; overflow-wrap: anywhere; }
.ai-switch { appearance: none; position: relative; width: 30px; height: 18px; flex: 0 0 30px; margin: 0; border-radius: 10px; background: #a4afa9; cursor: pointer; }
.ai-switch::after { content: ''; position: absolute; width: 12px; height: 12px; top: 3px; left: 3px; border-radius: 50%; background: #fff; }
.ai-switch:checked { background: #197053; }
.ai-switch:checked::after { left: 15px; }
.ai-switch:disabled { opacity: .5; cursor: not-allowed; }
.ai-switch:focus-visible { outline: 2px solid #197053; outline-offset: 3px; }
.ai-edit-form input { min-width: 0; flex: 1; height: 28px; padding: 0 8px; border: 1px solid #d3dfda; border-radius: 5px; font: inherit; font-size: 9px; }
.ai-edit-form button:disabled { opacity: .5; cursor: not-allowed; }
.ai-error { margin: 6px 0 0; font-size: 9px; }
.session-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid #e9efec; }
.session-item:last-child { border-bottom: 0; }
.session-item strong, .session-item span { display: block; }
.session-item strong { color: #344b42; font-size: 10px; }
.session-item span { margin-top: 3px; max-width: 230px; overflow: hidden; color: #7c8c85; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.session-item small { color: #7b8b84; font-size: 9px; white-space: nowrap; }
.audit-list { position: relative; }
.audit-list article { position: relative; display: flex; gap: 9px; padding-bottom: 13px; }
.audit-dot { flex: 0 0 7px; width: 7px; height: 7px; margin-top: 4px; border-radius: 50%; background: #6ca48d; box-shadow: 0 0 0 3px #eaf4f0; }
.audit-list strong { color: #354b43; font-size: 10px; }
.audit-list p, .audit-list small { display: block; margin: 3px 0 0; color: #7d8d86; font-size: 9px; }
.empty-note { padding: 22px 12px; border: 1px dashed #dce6e2; border-radius: 6px; color: #84938d; text-align: center; font-size: 10px; }
.privacy-note { display: flex; gap: 8px; margin-top: 17px; padding: 10px 11px; border: 1px solid #d8e8e1; border-radius: 6px; background: #f3faf7; color: #547066; font-size: 9px; line-height: 1.6; }
.privacy-note svg { flex: 0 0 16px; color: #33795f; }
.drawer-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; padding: 12px 18px 16px; border-top: 1px solid #e1e9e6; background: #fff; }
.action-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; border: 1px solid #d3dfda; border-radius: 6px; background: #fff; color: #3f5a50; font: inherit; font-size: 10px; font-weight: 650; cursor: pointer; }
.action-button.danger { border-color: #ecd3d6; color: #a34850; }
.action-button:disabled { opacity: .5; cursor: not-allowed; }
@media (max-width: 860px) {
  .detail-drawer { min-height: 0; }
  .drawer-state { min-height: 240px; }
  .drawer-body { max-height: none; }
}
</style>
