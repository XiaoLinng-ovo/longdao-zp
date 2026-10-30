<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RefreshCw, Search } from '@lucide/vue'
import { authSession } from '../../../auth/session'
import { describeApiFailure } from '../../../../shared/utils/errorMessage'
import UserDetailDrawer from '../components/UserDetailDrawer.vue'
import {
  getPlatformUser,
  listPlatformUsers,
  resetPlatformUserPassword,
  revokePlatformUserSessions,
  updatePlatformUserProfile,
  updatePlatformUserStatus,
  type PlatformUserDetail,
  type PlatformUserListItem,
  type PlatformUserRoleFilter,
  type PlatformUserStatusFilter,
} from '../api'

type ActionKind = 'status' | 'revoke' | 'reset' | 'profile'

const users = ref<PlatformUserListItem[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const query = ref('')
const status = ref<PlatformUserStatusFilter | ''>('')
const platformRole = ref<PlatformUserRoleFilter | ''>('')
const loading = ref(false)
const listError = ref('')
const notice = ref('')
const selectedId = ref('')
const detail = ref<PlatformUserDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref('')
const actionKind = ref<ActionKind | null>(null)
const actionReason = ref('')
const actionError = ref('')
const actionSaving = ref(false)
const profileName = ref('')
const profilePhone = ref('')
const temporaryCredential = ref<{ email: string; password: string; revokedSessions: number } | null>(null)
const copyNotice = ref('')

const canWrite = computed(() => authSession.user?.platformRole === 'admin')
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
const enabledOnPage = computed(() => users.value.filter((item) => item.isActive).length)
const registrationsOnPage = computed(() => users.value.filter((item) => item.registrationSource === 'open_registration').length)
const platformAdminsOnPage = computed(() => users.value.filter((item) => item.platformRole === 'admin').length)

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
const actionTitles: Record<ActionKind, string> = {
  status: '调整账号状态',
  revoke: '强制退出所有会话',
  reset: '重置登录密码',
  profile: '编辑基础资料',
}

function time(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}

function openAccount(account: PlatformUserListItem) {
  void loadDetail(account.id)
}

async function loadDetail(id: string) {
  selectedId.value = id
  detailLoading.value = true
  detailError.value = ''
  try {
    detail.value = await getPlatformUser(id)
  } catch (cause) {
    detail.value = null
    detailError.value = describeApiFailure(cause, '读取用户详情失败').message
  } finally {
    detailLoading.value = false
  }
}

function closeDetail() {
  selectedId.value = ''
  detail.value = null
  detailError.value = ''
}

function updateDetail(updated: PlatformUserDetail, workspaceId: string) {
  if (selectedId.value !== updated.user.id || !detail.value) return
  const workspace = updated.workspaces.find(item => item.id === workspaceId)
  if (workspace) detail.value.workspaces = detail.value.workspaces.map(item => item.id === workspaceId ? workspace : item)
  const audits = new Map([...detail.value.recentAudit, ...updated.recentAudit].map(item => [`${item.source}:${item.id}`, item]))
  detail.value.recentAudit = [...audits.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 30)
}

async function load(reset = false) {
  if (loading.value) return
  if (reset) page.value = 1
  loading.value = true
  listError.value = ''
  notice.value = ''
  try {
    const result = await listPlatformUsers({
      q: query.value,
      status: status.value,
      platformRole: platformRole.value,
      page: page.value,
      pageSize,
    })
    users.value = result.items
    total.value = result.total
    page.value = result.page
    if (!selectedId.value && result.items[0]) await loadDetail(result.items[0].id)
    else if (selectedId.value && !result.items.some((item) => item.id === selectedId.value)) closeDetail()
  } catch (cause) {
    users.value = []
    total.value = 0
    listError.value = describeApiFailure(cause, '读取平台用户失败').message
  } finally {
    loading.value = false
  }
}

async function turn(delta: number) {
  if (loading.value || actionSaving.value) return
  page.value += delta
  await load()
}

function openAction(kind: ActionKind) {
  if (!detail.value || !canWrite.value) return
  actionKind.value = kind
  actionReason.value = ''
  actionError.value = ''
  copyNotice.value = ''
  if (kind === 'profile') {
    profileName.value = detail.value.user.displayName
    profilePhone.value = detail.value.user.phone ?? ''
  }
}

function closeAction() {
  if (actionSaving.value) return
  actionKind.value = null
  actionError.value = ''
}

async function submitAction() {
  const account = detail.value
  const kind = actionKind.value
  if (!account || !kind || actionSaving.value) return
  actionError.value = ''
  if (actionReason.value.trim().length < 2 || actionReason.value.trim().length > 500) {
    actionError.value = '请填写 2～500 字的操作原因'
    return
  }
  actionSaving.value = true
  try {
    if (kind === 'status') {
      detail.value = await updatePlatformUserStatus(account.user.id, !account.user.isActive, actionReason.value.trim())
      notice.value = `${account.user.displayName} 的账号状态已更新`
    } else if (kind === 'revoke') {
      const result = await revokePlatformUserSessions(account.user.id, actionReason.value.trim())
      notice.value = `已撤销 ${result.revokedSessions} 个活跃会话`
      await loadDetail(account.user.id)
    } else if (kind === 'reset') {
      const result = await resetPlatformUserPassword(account.user.id, actionReason.value.trim())
      temporaryCredential.value = {
        email: account.user.email,
        password: result.temporaryPassword,
        revokedSessions: result.revokedSessions,
      }
      notice.value = `密码已重置，并撤销 ${result.revokedSessions} 个活跃会话`
      await loadDetail(account.user.id)
    } else {
      if (profileName.value.trim().length < 2) {
        actionError.value = '姓名至少需要 2 个字符'
        return
      }
      detail.value = await updatePlatformUserProfile(account.user.id, {
        displayName: profileName.value.trim(),
        phone: profilePhone.value.trim() || null,
        reason: actionReason.value.trim(),
      })
      notice.value = `${profileName.value.trim()} 的账号资料已更新`
    }
    actionKind.value = null
    const result = await listPlatformUsers({ q: query.value, status: status.value, platformRole: platformRole.value, page: page.value, pageSize })
    users.value = result.items
    total.value = result.total
  } catch (cause) {
    actionError.value = describeApiFailure(cause, '操作失败，请刷新后重试').message
  } finally {
    actionSaving.value = false
  }
}

async function copyCredential() {
  if (!temporaryCredential.value) return
  copyNotice.value = ''
  try {
    await navigator.clipboard.writeText(`账号：${temporaryCredential.value.email}\n临时密码：${temporaryCredential.value.password}`)
    copyNotice.value = '已复制'
  } catch {
    copyNotice.value = '复制失败，请手动选中密码'
  }
}

onMounted(() => load())
</script>

<template>
  <main class="platform-users-page">
    <header class="page-heading">
      <div>
        <p class="eyebrow">PLATFORM OPERATIONS · USER DIRECTORY</p>
        <h1>用户管理</h1>
        <p>查看开放注册产生的账号、企业归属、登录安全与操作记录。</p>
      </div>
      <div class="heading-meta">
        <span class="access-badge">{{ canWrite ? '平台管理员' : '平台只读运营' }}</span>
        <button class="refresh-button" type="button" :disabled="loading" @click="load()">
          <RefreshCw :size="14" :class="{ spinning: loading }" />
          {{ loading ? '刷新中' : '刷新' }}
        </button>
      </div>
    </header>

    <section class="boundary-note">
      <strong>账号支持视图</strong>
      <span>本页仅展示账号和企业归属，不展示候选人简历、面试录音、面试评价、Offer 正文或任何模型密钥。</span>
    </section>

    <p v-if="listError" class="feedback error" role="alert">{{ listError }}</p>
    <p v-if="notice" class="feedback success" role="status">{{ notice }}</p>

    <section class="overview-strip" aria-label="用户概况">
      <div><span>全部账号</span><strong>{{ total }}</strong></div>
      <div><span>本页启用</span><strong>{{ enabledOnPage }}</strong></div>
      <div><span>本页开放注册</span><strong>{{ registrationsOnPage }}</strong></div>
      <div><span>本页平台管理员</span><strong>{{ platformAdminsOnPage }}</strong></div>
    </section>

    <div class="directory-layout" :class="{ 'detail-open': detail || detailLoading || detailError }">
      <section class="directory-panel">
        <form class="filters" @submit.prevent="load(true)">
          <label class="search-field">
            <Search :size="15" />
            <input v-model="query" maxlength="120" placeholder="搜索姓名、邮箱、手机号、用户 ID 或企业名称" aria-label="搜索用户" />
          </label>
          <select v-model="status" aria-label="账号状态" @change="load(true)">
            <option value="">全部状态</option>
            <option value="active">启用</option>
            <option value="disabled">停用</option>
          </select>
          <select v-model="platformRole" aria-label="平台身份" @change="load(true)">
            <option value="">全部平台身份</option>
            <option value="admin">平台管理员</option>
            <option value="viewer">平台只读</option>
            <option value="none">普通账号</option>
          </select>
          <button class="search-button" type="submit" :disabled="loading">{{ loading ? '查询中' : '查询' }}</button>
        </form>

        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th class="user-column">用户</th>
                <th>所属企业</th>
                <th>企业身份</th>
                <th>状态</th>
                <th>最近登录</th>
                <th class="action-column">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="account in users"
                :key="account.id"
                :class="{ selected: selectedId === account.id }"
                :data-testid="`user-row-${account.id}`"
                @click="openAccount(account)"
              >
                <td>
                  <div class="user-cell">
                    <span class="avatar">{{ account.displayName.slice(0, 1) }}</span>
                    <div>
                      <strong>{{ account.displayName }}</strong>
                      <span>{{ account.email }}</span>
                      <small>{{ account.phoneMasked || account.id }}</small>
                    </div>
                  </div>
                </td>
                <td>
                  <div v-if="account.primaryWorkspace" class="workspace-cell">
                    <span>{{ account.primaryWorkspace.name.slice(0, 1) }}</span>
                    <div><strong>{{ account.primaryWorkspace.name }}</strong><small>{{ serviceLabels[account.primaryWorkspace.serviceStatus] }}</small></div>
                  </div>
                  <span v-else class="muted">未加入企业</span>
                </td>
                <td>
                  <span v-if="account.primaryWorkspace" class="role-chip" :class="{ owner: account.primaryWorkspace.membershipRole === 'owner' }">
                    {{ roleLabels[account.primaryWorkspace.membershipRole] }}
                  </span>
                  <span v-else>—</span>
                </td>
                <td><span class="status-chip" :class="{ disabled: !account.isActive }">{{ account.isActive ? '启用' : '停用' }}</span></td>
                <td>
                  <span class="time-cell">{{ time(account.lastLoginAt) }}</span>
                  <small class="time-sub">注册 {{ time(account.createdAt) }}</small>
                </td>
                <td><button class="text-action" type="button" @click.stop="openAccount(account)">查看</button></td>
              </tr>
              <tr v-if="!users.length">
                <td colspan="6" class="empty-cell">{{ loading ? '正在加载用户...' : listError ? '读取失败，请重试' : '没有符合筛选条件的用户' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <footer class="pagination">
          <span>第 {{ page }} / {{ totalPages }} 页 · 共 {{ total }} 个账号</span>
          <div>
            <button type="button" :disabled="page <= 1 || loading" @click="turn(-1)">上一页</button>
            <button type="button" :disabled="page >= totalPages || loading" @click="turn(1)">下一页</button>
          </div>
        </footer>
      </section>

      <UserDetailDrawer
        :detail="detail"
        :loading="detailLoading"
        :error="detailError"
        :can-write="canWrite"
        @close="closeDetail"
        @action="openAction"
        @update:detail="updateDetail"
      />
    </div>

    <div v-if="actionKind" class="dialog-backdrop" role="presentation" @click.self="closeAction">
      <section class="action-dialog" role="dialog" aria-modal="true" :aria-label="actionTitles[actionKind]">
        <header>
          <div><small>平台账号操作</small><h2>{{ actionTitles[actionKind] }}</h2></div>
          <button class="dialog-close" type="button" aria-label="关闭操作面板" :disabled="actionSaving" @click="closeAction">×</button>
        </header>
        <p v-if="detail" class="dialog-target">{{ detail.user.displayName }} · {{ detail.user.email }}</p>
        <p v-if="actionKind === 'status'" class="dialog-help">{{ detail?.user.isActive ? '停用后将立即撤销该用户全部有效登录会话。' : '启用后用户可重新登录，但不会恢复旧会话。' }}</p>
        <p v-else-if="actionKind === 'revoke'" class="dialog-help">该操作会立即撤销用户当前全部有效登录会话。</p>
        <p v-else-if="actionKind === 'reset'" class="dialog-help">系统将生成一次性临时密码，并立即撤销全部有效登录会话。临时密码只显示一次。</p>
        <div v-else class="profile-fields">
          <label>姓名<input v-model="profileName" maxlength="80" /></label>
          <label>手机号<input v-model="profilePhone" type="tel" placeholder="留空表示清空" /></label>
        </div>
        <label class="reason-field">
          操作原因（必填）
          <textarea v-model="actionReason" rows="3" maxlength="500" placeholder="例如：用户身份核验后申请重置密码" :disabled="actionSaving"></textarea>
        </label>
        <p v-if="actionError" class="dialog-error" role="alert">{{ actionError }}</p>
        <footer>
          <button class="secondary-button" type="button" :disabled="actionSaving" @click="closeAction">取消</button>
          <button class="primary-button" type="button" :disabled="actionSaving" @click="submitAction">{{ actionSaving ? '处理中...' : '确认执行' }}</button>
        </footer>
      </section>
    </div>

    <div v-if="temporaryCredential" class="dialog-backdrop" role="presentation">
      <section class="action-dialog credential-dialog" role="dialog" aria-modal="true" aria-label="临时密码">
        <header><div><small>仅显示一次</small><h2>临时登录密码</h2></div></header>
        <p class="dialog-target">{{ temporaryCredential.email }}</p>
        <code>{{ temporaryCredential.password }}</code>
        <p class="dialog-help">该密码不会再次显示。用户登录后应尽快修改密码。已撤销 {{ temporaryCredential.revokedSessions }} 个会话。</p>
        <p v-if="copyNotice" class="copy-notice">{{ copyNotice }}</p>
        <footer>
          <button class="secondary-button" type="button" @click="copyCredential">复制账号和密码</button>
          <button class="primary-button" type="button" @click="temporaryCredential = null; copyNotice = ''">我已妥善保存</button>
        </footer>
      </section>
    </div>
  </main>
</template>

<style scoped>
.platform-users-page { display: grid; gap: 16px; color: #2f443c; }
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 22px 24px; border: 1px solid #d8e7e1; border-radius: 8px; background: #f6faf8; }
.eyebrow { margin: 0; color: #6f9a8c; font-size: 9px; font-weight: 700; letter-spacing: .12em; }
.page-heading h1 { margin: 7px 0 0; color: #20372f; font-size: 24px; letter-spacing: -.02em; }
.page-heading p:last-child { margin: 7px 0 0; color: #70827b; font-size: 12px; line-height: 1.6; }
.heading-meta { display: flex; align-items: center; gap: 8px; }
.access-badge { padding: 6px 9px; border: 1px solid #c8ded5; border-radius: 5px; background: #fff; color: #276b55; font-size: 10px; font-weight: 700; }
.refresh-button { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 10px; border: 1px solid #d2ded9; border-radius: 6px; background: #fff; color: #4a6258; font: inherit; font-size: 10px; cursor: pointer; }
.refresh-button:disabled { opacity: .6; cursor: wait; }
.spinning { animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.boundary-note { display: flex; gap: 10px; padding: 11px 14px; border: 1px solid #dce8e3; border-radius: 7px; background: #fff; color: #60756c; font-size: 10px; line-height: 1.6; }
.boundary-note strong { flex: 0 0 auto; color: #355449; }
.feedback { margin: 0; padding: 10px 13px; border-radius: 7px; font-size: 11px; }
.feedback.error { border: 1px solid #edcfd2; background: #fff5f6; color: #aa474f; }
.feedback.success { border: 1px solid #cfe5da; background: #f3fbf7; color: #2a7459; }
.overview-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); overflow: hidden; border: 1px solid #dfe8e4; border-radius: 7px; background: #dfe8e4; gap: 1px; }
.overview-strip > div { padding: 12px 14px; background: #fff; }
.overview-strip span, .overview-strip strong { display: block; }
.overview-strip span { color: #7c8d86; font-size: 9.5px; }
.overview-strip strong { margin-top: 5px; color: #294238; font-size: 19px; }
.directory-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
.directory-layout.detail-open { grid-template-columns: minmax(0, 1fr) 390px; }
.directory-panel { min-width: 0; overflow: hidden; border: 1px solid #dfe8e4; border-radius: 7px; background: #fff; }
.filters { display: flex; align-items: center; gap: 8px; padding: 13px; border-bottom: 1px solid #e5ece9; }
.search-field { position: relative; flex: 1; min-width: 220px; }
.search-field svg { position: absolute; top: 10px; left: 10px; color: #84968e; }
.search-field input { width: 100%; height: 35px; padding: 0 11px 0 32px; }
.filters input, .filters select, .profile-fields input, .reason-field textarea { box-sizing: border-box; border: 1px solid #d4e0db; border-radius: 6px; background: #fbfdfc; color: #2f443c; font: inherit; font-size: 10.5px; outline: none; }
.filters select { height: 35px; padding: 0 28px 0 10px; }
.filters input:focus, .filters select:focus, .profile-fields input:focus, .reason-field textarea:focus { border-color: #7fb39f; box-shadow: 0 0 0 3px rgba(31, 121, 88, .08); }
.search-button { height: 35px; padding: 0 13px; border: 1px solid #176d54; border-radius: 6px; background: #176d54; color: #fff; font: inherit; font-size: 10.5px; font-weight: 650; cursor: pointer; }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th { height: 38px; padding: 0 10px; border-bottom: 1px solid #e5ece9; background: #f8faf9; color: #71827b; font-size: 9.5px; font-weight: 650; text-align: left; white-space: nowrap; }
td { height: 64px; padding: 8px 10px; border-bottom: 1px solid #edf1ef; font-size: 10px; vertical-align: middle; }
tbody tr { cursor: pointer; transition: background .14s ease; }
tbody tr:hover { background: #f8fbfa; }
tbody tr.selected { background: #eef8f4; box-shadow: inset 3px 0 0 #177a5b; }
tbody tr:last-child td { border-bottom: 0; }
.user-column { width: 31%; }
.action-column { width: 7%; }
.user-cell { display: flex; align-items: center; gap: 9px; min-width: 0; }
.avatar { display: grid; place-items: center; flex: 0 0 31px; width: 31px; height: 31px; border-radius: 50%; background: #e4efe9; color: #356653; font-size: 10px; font-weight: 750; }
.user-cell > div { min-width: 0; }
.user-cell strong, .user-cell span, .user-cell small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.user-cell strong { color: #2d433a; font-size: 10.5px; }
.user-cell span { margin-top: 3px; color: #71827b; font-size: 9px; }
.user-cell small { margin-top: 3px; color: #91a099; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 8.5px; }
.workspace-cell { display: flex; align-items: center; gap: 7px; min-width: 0; }
.workspace-cell > span { display: grid; place-items: center; flex: 0 0 23px; width: 23px; height: 23px; border-radius: 5px; background: #edf2f0; color: #587167; font-size: 9px; font-weight: 700; }
.workspace-cell > div { min-width: 0; }
.workspace-cell strong, .workspace-cell small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-cell strong { color: #344a41; font-size: 9.5px; }
.workspace-cell small { margin-top: 3px; color: #82928c; font-size: 8.5px; }
.role-chip, .status-chip { display: inline-flex; align-items: center; min-height: 20px; padding: 0 7px; border-radius: 999px; background: #edf2f0; color: #5e7068; font-size: 9px; font-weight: 650; white-space: nowrap; }
.role-chip.owner { background: #fff1de; color: #8a5618; }
.status-chip { background: #e7f5ee; color: #1f7658; }
.status-chip::before { content: ""; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: #26976a; }
.status-chip.disabled { background: #f9ecee; color: #a74951; }
.status-chip.disabled::before { background: #b7565d; }
.time-cell { display: block; color: #4a6157; font-size: 9.5px; white-space: nowrap; }
.time-sub { display: block; margin-top: 3px; color: #8b9993; font-size: 8.5px; white-space: nowrap; }
.text-action { padding: 0; border: 0; background: transparent; color: #2c725b; font: inherit; font-size: 9.5px; cursor: pointer; }
.text-action:hover { text-decoration: underline; }
.muted { color: #87958f; }
.empty-cell { height: 180px; color: #81918a; text-align: center; }
.pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 13px; border-top: 1px solid #e6ece9; color: #74857e; font-size: 9.5px; }
.pagination div { display: flex; gap: 6px; }
.pagination button { min-height: 28px; padding: 0 9px; border: 1px solid #d7e2dd; border-radius: 5px; background: #fff; color: #4b6258; font: inherit; font-size: 9px; cursor: pointer; }
.pagination button:disabled { opacity: .45; cursor: not-allowed; }
.dialog-backdrop { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 20px; background: rgba(18, 31, 27, .48); }
.action-dialog { width: min(440px, 100%); padding: 18px; border: 1px solid #dbe5e1; border-radius: 8px; background: #fff; box-shadow: 0 24px 70px rgba(20, 45, 36, .24); }
.action-dialog header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.action-dialog header small { color: #81918a; font-size: 9px; }
.action-dialog h2 { margin: 5px 0 0; color: #293f36; font-size: 17px; }
.dialog-close { border: 0; background: transparent; color: #6e7e77; font-size: 22px; line-height: 1; cursor: pointer; }
.dialog-target { margin: 15px 0 0; padding: 9px 10px; border-radius: 6px; background: #f4f8f6; color: #435a50; font-size: 10px; }
.dialog-help { color: #71827b; font-size: 10px; line-height: 1.65; }
.profile-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 12px; }
.profile-fields label, .reason-field { display: grid; gap: 6px; color: #61736b; font-size: 9.5px; }
.profile-fields input { height: 35px; padding: 0 10px; }
.reason-field { margin-top: 12px; }
.reason-field textarea { min-height: 90px; padding: 9px 10px; resize: vertical; }
.dialog-error { margin: 8px 0 0; color: #ab434a; font-size: 10px; }
.action-dialog footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.primary-button, .secondary-button { min-height: 34px; padding: 0 12px; border-radius: 6px; font: inherit; font-size: 10px; font-weight: 650; cursor: pointer; }
.primary-button { border: 1px solid #176d54; background: #176d54; color: #fff; }
.secondary-button { border: 1px solid #d6e1dc; background: #fff; color: #4e655b; }
.primary-button:disabled, .secondary-button:disabled { opacity: .55; cursor: wait; }
.credential-dialog code { display: block; margin: 12px 0; padding: 13px; border: 1px solid #cfe2d9; border-radius: 6px; background: #f4faf7; color: #205b45; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 16px; font-weight: 700; user-select: all; overflow-wrap: anywhere; }
.copy-notice { color: #26775b; font-size: 10px; }
@media (max-width: 1120px) {
  .directory-layout.detail-open { grid-template-columns: minmax(0, 1fr) 340px; }
}
@media (max-width: 900px) {
  .directory-layout.detail-open { grid-template-columns: minmax(0, 1fr); }
  .page-heading { flex-direction: column; }
  .filters { align-items: stretch; flex-wrap: wrap; }
  .search-field { flex-basis: 100%; }
  .overview-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .profile-fields { grid-template-columns: 1fr; }
  .overview-strip { grid-template-columns: 1fr 1fr; }
  .page-heading { padding: 18px; }
}
</style>
