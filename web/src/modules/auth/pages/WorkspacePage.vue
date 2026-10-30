<script setup lang="ts">
import { isWorkspaceAvailable, workspaceServiceLabel } from '../utils/workspace-service'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { archiveWorkspace, createWorkspace, listWorkspaces, resetWorkspace, type WorkspaceKind, type WorkspaceSummary } from '../api'
import { authSession, logoutCurrentUser, refreshAuthSession, switchWorkspace } from '../session'
import EnterpriseEntitlements from '../../platform/components/EnterpriseEntitlements.vue'
import JoinWorkspaceCard from '../components/JoinWorkspaceCard.vue'
import WorkspaceInvitationManager from '../components/WorkspaceInvitationManager.vue'
import { describeApiFailure } from '../../../shared/utils/errorMessage'

const router = useRouter()
const entitlementWorkspace = ref<WorkspaceSummary | null>(null)
const managingWorkspaceId = ref('')
const managingWorkspace = computed(() => workspaces.value.find(workspace => workspace.id === managingWorkspaceId.value && isWorkspaceAvailable(workspace) && ['owner','admin'].includes(workspace.role)))
const workspaces = ref<WorkspaceSummary[]>([])
const name = ref('')
const kind = ref<WorkspaceKind>('test')
const loading = ref(true)
const submitting = ref(false)
const switchingId = ref('')
const error = ref('')
const notice = ref('')
const returningToLogin = ref(false)
const activeWorkspace = computed(() => authSession.user?.workspaceId)

async function load() {
  loading.value = true
  try {
    const loaded = await listWorkspaces()
    workspaces.value = loaded
    authSession.workspaces = loaded
  } catch (cause) {
    error.value = describeApiFailure(cause, '无法读取企业列表').message
  } finally { loading.value = false }
}

async function create() {
  if (submitting.value) return
  if (name.value.trim().length < 2) { error.value = '请输入至少 2 个字符的企业名称'; return }
  submitting.value = true; error.value = ''; notice.value = ''
  try {
    const workspace = await createWorkspace(name.value.trim(), kind.value)
    name.value = ''
    const loaded = await listWorkspaces()
    workspaces.value = loaded
    authSession.workspaces = loaded
    await switchWorkspace(workspace.id)
    notice.value = `${workspace.name} 已创建，当前已切换到该工作空间`
  } catch (cause) { error.value = describeApiFailure(cause, '创建企业失败').message } finally { submitting.value = false }
}

async function choose(workspace: WorkspaceSummary) {
  if (!isWorkspaceAvailable(workspace) || switchingId.value) return
  if (workspace.id === activeWorkspace.value) { await router.push('/'); return }
  switchingId.value = workspace.id
  error.value = ''
  try {
    await switchWorkspace(workspace.id)
    window.location.assign('/')
  } catch (cause) {
    error.value = describeApiFailure(cause, '切换失败').message
  } finally { switchingId.value = '' }
}

async function reset(workspace: WorkspaceSummary) {
  if (!window.confirm(`确定重新开始“${workspace.name}”吗？这只允许测试企业使用。`)) return
  try { await resetWorkspace(workspace.id); notice.value = '测试企业已恢复为可使用状态'; await load() } catch (cause) { error.value = describeApiFailure(cause, '重置失败').message }
}

async function archive(workspace: WorkspaceSummary) {
  if (!window.confirm(`确定归档“${workspace.name}”吗？归档后不会再出现在可切换列表中。`)) return
  try { await archiveWorkspace(workspace.id); await refreshAuthSession(); notice.value = '企业已归档'; await load() } catch (cause) { error.value = describeApiFailure(cause, '归档失败').message }
}

async function returnToLogin() {
  if (returningToLogin.value) return
  returningToLogin.value = true
  error.value = ''
  let logoutFailed = false
  try { await logoutCurrentUser() } catch { logoutFailed = true }
  try {
    await router.replace({ name: 'login', query: logoutFailed ? { logoutError: '1' } : {} })
  } finally { returningToLogin.value = false }
}

onMounted(load)
</script>

<template>
  <main class="workspace-shell" :class="{ 'is-embedded': Boolean(activeWorkspace) }">
    <section class="workspace-card">
      <header class="workspace-header">
        <div class="workspace-header-copy">
          <router-link v-if="authSession.user?.platformRole" to="/platform/customers">进入平台企业客户管理 →</router-link>
          <span class="workspace-kicker">SMART RECRUIT · WORKSPACES</span>
          <h1>企业工作空间</h1>
          <p>新企业默认试用 14 天，现有企业保持启用。创建自己的企业，或粘贴管理员发来的邀请码加入。企业成员关系与业务角色分别管理，加入后可以切换工作空间。</p>
        </div>
        <router-link v-if="activeWorkspace" class="workspace-logout" to="/">
          <span aria-hidden="true">←</span>返回招聘工作台
        </router-link>
        <button
          v-else
          class="workspace-logout"
          type="button"
          :disabled="returningToLogin"
          :aria-busy="returningToLogin"
          @click="returnToLogin"
        >
          <span aria-hidden="true">←</span>{{ returningToLogin ? '正在退出…' : '返回登录' }}
        </button>
      </header>

      <div v-if="error" class="workspace-message error" role="alert">{{ error }}</div>
      <div v-if="notice" class="workspace-message success">{{ notice }}</div>

      <JoinWorkspaceCard @joined="load" />

      <section class="workspace-create" aria-labelledby="workspace-create-title">
        <div class="workspace-create-copy">
          <span class="workspace-create-icon" aria-hidden="true">＋</span>
          <div>
            <strong id="workspace-create-title">新建工作空间</strong>
            <span>测试企业适合体验，正式企业用于日常招聘；创建者自动成为企业所有者。</span>
          </div>
        </div>
        <form class="workspace-create-form" @submit.prevent="create">
          <input v-model="name" placeholder="例如：龙道测试企业" aria-label="企业名称" />
          <select v-model="kind" aria-label="企业类型">
            <option value="test">测试企业</option>
            <option value="production">正式企业</option>
          </select>
          <button class="workspace-create-btn" type="submit" :disabled="submitting">
            <span aria-hidden="true">＋</span>{{ submitting ? '创建中...' : '新建企业' }}
          </button>
        </form>
      </section>

      <div class="workspace-list-title">
        <div><strong>我的企业</strong><span>{{ workspaces.length }} 个</span></div>
        <span class="workspace-list-caption">选择一个工作空间开始管理</span>
      </div>
      <div v-if="loading" class="workspace-empty">正在加载企业列表…</div>
      <div v-else-if="!workspaces.length" class="workspace-empty">还没有企业。可以粘贴邀请码加入，或创建自己的企业。</div>
      <div v-else class="workspace-list" aria-label="企业工作空间列表">
        <article v-for="workspace in workspaces" :key="workspace.id" class="workspace-row" :class="{ archived: workspace.status === 'archived', current: activeWorkspace === workspace.id }">
          <div class="workspace-type"><span>{{ workspace.kind === 'test' ? '测' : '正' }}</span></div>
          <div class="workspace-info">
            <strong>{{ workspace.name }}</strong>
            <span>{{ workspace.kind === 'test' ? '测试企业' : '正式企业' }} · {{ workspaceServiceLabel(workspace) }}</span>
          </div>
          <div class="workspace-row-actions">
            <button v-if="workspace.status === 'active' && ['owner','admin'].includes(workspace.role)" class="workspace-action" type="button" @click="managingWorkspaceId = managingWorkspaceId === workspace.id ? '' : workspace.id">{{ managingWorkspaceId === workspace.id ? '收起管理' : '成员与邀请' }}</button>
            <button v-if="workspace.status === 'active'" class="workspace-action" type="button" @click="entitlementWorkspace = entitlementWorkspace?.id === workspace.id ? null : workspace">套餐权益</button>
            <RouterLink v-if="workspace.status === 'active' && ['owner','admin'].includes(workspace.role) && (!activeWorkspace || activeWorkspace === workspace.id)" class="workspace-action" :to="{name:'enterprise-payments',query:{workspace:workspace.id}}">购买 / 续费套餐</RouterLink>
            <span v-if="activeWorkspace === workspace.id" class="workspace-current">当前</span>
            <button v-if="workspace.status === 'active'" class="workspace-open" type="button" :disabled="!isWorkspaceAvailable(workspace) || Boolean(switchingId)" @click="choose(workspace)">{{ !isWorkspaceAvailable(workspace) ? workspaceServiceLabel(workspace) : switchingId === workspace.id ? '切换中…' : activeWorkspace === workspace.id ? '进入' : '切换' }}</button>
            <button v-if="workspace.role === 'owner' && workspace.kind === 'test'" class="workspace-action" type="button" @click="reset(workspace)">重新开始</button>
            <button v-if="workspace.role === 'owner' && workspace.status === 'active'" class="workspace-action danger" type="button" @click="archive(workspace)">归档</button>
          </div>
        </article>
      </div>
      <EnterpriseEntitlements v-if="entitlementWorkspace" :key="entitlementWorkspace.id" :organization-id="entitlementWorkspace.id" :name="entitlementWorkspace.name" />
      <WorkspaceInvitationManager v-if="managingWorkspace" :key="managingWorkspace.id" :workspace="managingWorkspace" />
      <footer>当前账号：{{ authSession.user?.email }} · 企业之间的数据和成员关系独立管理。</footer>
    </section>
  </main>
</template>

<style scoped>
.workspace-shell {
  min-height: 100vh;
  padding: 48px 20px;
  background: radial-gradient(circle at 8% 0%, rgba(118, 219, 205, .28), transparent 31%), radial-gradient(circle at 94% 12%, rgba(139, 181, 239, .22), transparent 29%), linear-gradient(135deg, #f4fbfb 0%, #eef4fb 100%);
}
.workspace-shell.is-embedded { min-height: auto; padding: 0; background: transparent; }
.workspace-shell.is-embedded .workspace-card { width: 100%; margin: 0; padding: 0 0 18px; border: 0; border-radius: 0; background: transparent; box-shadow: none; backdrop-filter: none; }
.workspace-shell.is-embedded .workspace-card::before { display: none; }
.workspace-shell.is-embedded .workspace-header { padding-top: 2px; }
.workspace-card {
  position: relative;
  width: min(100%, 980px);
  margin: 0 auto;
  padding: 38px 40px 30px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .92);
  border-radius: 28px;
  background: rgba(255, 255, 255, .9);
  box-shadow: 0 26px 70px rgba(53, 96, 123, .14), 0 3px 14px rgba(75, 128, 150, .06);
  backdrop-filter: blur(18px);
}
.workspace-card::before { position: absolute; top: 0; right: 0; left: 0; height: 4px; background: linear-gradient(90deg, #5fc5b7, #65a6e9, #a0a7ec); content: ''; }
.workspace-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 36px; }
.workspace-header-copy { min-width: 0; }
.workspace-kicker { display: inline-flex; color: #63a8ad; font-size: 10px; font-weight: 800; letter-spacing: .15em; }
.workspace-header h1 { margin: 9px 0 0; color: #214c64; font-size: clamp(27px, 4vw, 34px); letter-spacing: -.05em; }
.workspace-header p { max-width: 700px; margin: 12px 0 0; color: #7893a1; font-size: 12px; line-height: 1.8; }
.workspace-logout { display: inline-flex; align-items: center; flex: 0 0 auto; gap: 5px; margin-top: 4px; padding: 8px 11px; border: 1px solid #dcebef; border-radius: 10px; background: rgba(248, 253, 254, .78); color: #568294; font: inherit; font-size: 11px; text-decoration: none; cursor: pointer; transition: transform .18s ease, border-color .18s ease, background .18s ease, box-shadow .18s ease; }
.workspace-logout:focus-visible { outline: 3px solid rgba(78, 145, 223, .35); outline-offset: 2px; }
.workspace-logout:disabled { opacity: .65; cursor: wait; transform: none; box-shadow: none; }
.workspace-logout:hover { transform: translateY(-1px); border-color: #b9dfe0; background: #fff; box-shadow: 0 7px 15px rgba(69, 132, 151, .1); }
.workspace-message { margin-top: 20px; padding: 11px 14px; border-radius: 12px; font-size: 12px; }
.workspace-message.error { border: 1px solid #f0cbd0; background: #fff4f5; color: #b65a69; }
.workspace-message.success { border: 1px solid #c9e7dc; background: #f1fbf6; color: #3a8a71; }
.workspace-create { display: flex; align-items: center; justify-content: space-between; gap: 30px; margin-top: 30px; padding: 21px 22px; border: 1px solid #d9ebee; border-radius: 19px; background: linear-gradient(135deg, rgba(246, 253, 252, .98), rgba(242, 247, 255, .98)); box-shadow: inset 0 1px 0 rgba(255, 255, 255, .85); }
.workspace-create-copy { display: flex; align-items: flex-start; min-width: 0; gap: 12px; }
.workspace-create-icon { display: grid; place-items: center; width: 34px; height: 34px; flex: 0 0 34px; border-radius: 11px; background: linear-gradient(145deg, #d9f4ed, #dceafb); color: #4a9daf; font-size: 23px; font-weight: 400; line-height: 1; }
.workspace-create-copy > div { display: grid; gap: 6px; min-width: 0; }
.workspace-create strong { color: #315870; font-size: 14px; }
.workspace-create span { color: #8aa0ac; font-size: 10.5px; line-height: 1.6; }
.workspace-create-form { display: flex; align-items: center; flex: 0 0 auto; gap: 9px; }
.workspace-create input, .workspace-create select { min-height: 42px; border: 1px solid #d3e5eb; border-radius: 11px; padding: 0 12px; background: rgba(255, 255, 255, .94); color: #456777; outline: 0; transition: border-color .18s ease, box-shadow .18s ease; }
.workspace-create input { width: 190px; }
.workspace-create select { width: 116px; cursor: pointer; }
.workspace-create input:focus, .workspace-create select:focus { border-color: #76bdc4; box-shadow: 0 0 0 4px rgba(111, 191, 192, .13); }
.workspace-create-btn, .workspace-open { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; gap: 5px; min-height: 42px; border: 0; border-radius: 11px; padding: 0 15px; background: linear-gradient(135deg, #4aa8ad, #4b91d6); color: #fff; font-size: 11px; font-weight: 700; white-space: nowrap; cursor: pointer; box-shadow: 0 8px 16px rgba(69, 143, 177, .18); transition: transform .18s ease, box-shadow .18s ease, filter .18s ease; }
.workspace-create-btn > span { display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px; flex: 0 0 19px; border: 1px solid rgba(255, 255, 255, .62); border-radius: 50%; color: #fff; font-size: 17px; font-weight: 500; line-height: 1; }
.workspace-create-btn:hover, .workspace-open:hover { transform: translateY(-1px); filter: saturate(1.08); box-shadow: 0 11px 21px rgba(69, 143, 177, .24); }
.workspace-create-btn:disabled, .workspace-open:disabled { opacity: .62; cursor: wait; transform: none; }
.workspace-list-title { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin-top: 31px; color: #315870; }
.workspace-list-title > div { display: flex; align-items: baseline; gap: 9px; }
.workspace-list-title strong { font-size: 15px; }
.workspace-list-title span { color: #9aadb7; font-size: 11px; }
.workspace-list-caption { color: #9aadb7; font-size: 10.5px; }
.workspace-list { display: grid; gap: 12px; margin-top: 13px; }
.workspace-row { display: flex; align-items: center; gap: 14px; min-height: 72px; padding: 12px 14px; border: 1px solid #e0edf1; border-radius: 16px; background: rgba(255, 255, 255, .74); transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease, background .18s ease; }
.workspace-row:hover { transform: translateY(-1px); border-color: #c4e3e4; background: #fff; box-shadow: 0 10px 22px rgba(69, 126, 148, .09); }
.workspace-row.current { border-color: #92d0ce; background: linear-gradient(135deg, #f3fcfa, #f6faff); box-shadow: 0 7px 17px rgba(77, 164, 155, .08); }
.workspace-row.archived { opacity: .62; }
.workspace-type { display: grid; place-items: center; width: 42px; height: 42px; flex: 0 0 42px; border-radius: 13px; background: linear-gradient(145deg, #def4ef, #e0ecfc); color: #348b90; font-size: 15px; font-weight: 800; }
.workspace-info { display: grid; min-width: 0; flex: 1; gap: 5px; }
.workspace-info strong { overflow: hidden; color: #365b6e; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.workspace-info span { color: #8ba1ad; font-size: 10.5px; }
.workspace-row-actions { display: flex; align-items: center; justify-content: flex-end; flex: 0 0 auto; gap: 8px; }
.workspace-current { color: #3e9a7d !important; font-size: 10px !important; font-weight: 700; }
.workspace-open { min-height: 34px; padding: 0 13px; border-radius: 9px; background: #4e91df; box-shadow: none; }
.workspace-action { min-height: 34px; border: 1px solid #d6e6eb; border-radius: 9px; padding: 0 10px; background: #fff; color: #668390; font-size: 10px; white-space: nowrap; cursor: pointer; transition: border-color .18s ease, background .18s ease; }
.workspace-action:hover { border-color: #b9d9df; background: #f7fcfd; }
.workspace-action.danger { color: #b76a72; }
.workspace-empty { margin-top: 13px; padding: 38px 30px; border: 1px dashed #cfdee4; border-radius: 16px; background: rgba(249, 253, 254, .68); color: #8ca1ac; text-align: center; font-size: 12px; }
.workspace-card footer { margin-top: 25px; color: #9aadb6; font-size: 10.5px; }
@media (max-width: 860px) { .workspace-create { align-items: stretch; flex-direction: column; gap: 18px; } .workspace-create-form { width: 100%; } .workspace-create input { flex: 1; width: auto; } }
@media (max-width: 680px) { .workspace-shell { padding: 24px 12px; } .workspace-card { padding: 29px 18px 24px; border-radius: 22px; } .workspace-header { flex-direction: column; gap: 16px; } .workspace-logout { align-self: flex-start; } .workspace-create-form { align-items: stretch; flex-wrap: wrap; } .workspace-create input { flex: 1 1 100%; } .workspace-create select { flex: 1; width: auto; } .workspace-create-btn { flex: 1; } .workspace-list-title { align-items: flex-start; flex-direction: column; gap: 7px; } .workspace-row { align-items: flex-start; flex-wrap: wrap; } .workspace-info { flex-basis: calc(100% - 58px); } .workspace-row-actions { width: 100%; margin-left: 56px; justify-content: flex-start; flex-wrap: wrap; } .workspace-empty { padding: 31px 17px; } }
</style>


