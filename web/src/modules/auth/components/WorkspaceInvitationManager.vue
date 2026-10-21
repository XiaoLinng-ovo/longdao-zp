<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { createInvitation, listInvitations, listWorkspaceMembers, listInvitationDepartments, revokeInvitation, updateWorkspaceMember, type Invitation, type InvitationInput, type WorkspaceMember } from '../api/invitations'
import { authSession } from '../session'
import { businessRoleLabels, membershipLabels, copyText, invitationLink, invitationText } from '../utils/invitations'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import type { WorkspaceSummary } from '../api'
const props = defineProps<{ workspace: WorkspaceSummary }>()
const invitations = ref<Invitation[]>([])
const members = ref<WorkspaceMember[]>([])
const departments = ref<{ id: string; name: string }[]>([])
const form = ref<InvitationInput>({ email:'',membershipRole:'member',businessRole:'recruiter',departmentId:null,expiresInDays:7 })
const memberForms = ref<Record<string, InvitationInput>>({})
const busy = ref(false), loading = ref(false), error = ref(''), notice = ref('')
const created = ref<Invitation | null>(null)
const localOnly = ['localhost','127.0.0.1','[::1]','::1'].includes(window.location.hostname)
const owner = computed(() => props.workspace.role === 'owner')
const statuses = { pending:'待加入', accepted:'已加入', expired:'已过期', revoked:'已撤销' }
let generation = 0
let expiryTimer: ReturnType<typeof setInterval> | undefined
function refreshExpiry() {
  for (const item of invitations.value) if (item.status === 'pending' && Date.parse(item.expiresAt) <= Date.now()) item.status = 'expired'
  if (created.value?.status === 'expired') created.value = null
}
onMounted(() => { expiryTimer = setInterval(refreshExpiry, 15000) })
onUnmounted(() => { clearInterval(expiryTimer); generation++ })
async function load() {
  const current = ++generation
  loading.value = true; error.value = ''; notice.value = ''; created.value = null
  invitations.value = []; members.value = []; departments.value = []
  try {
    const [i,m,d] = await Promise.all([listInvitations(props.workspace.id),listWorkspaceMembers(props.workspace.id),listInvitationDepartments()])
    if (current !== generation) return
    invitations.value = i; members.value = m; departments.value = d
    memberForms.value = Object.fromEntries(m.map(member => [member.id,{membershipRole:member.membershipRole === 'admin' ? 'admin' : 'member',businessRole:(['recruiter','hiring_manager','approver','interviewer'].includes(member.businessRole) ? member.businessRole : 'recruiter') as InvitationInput['businessRole'],departmentId:member.departmentId}]))
  } catch (cause) { if(current === generation) error.value = describeApiFailure(cause,'读取成员邀请失败').message }
  finally { if(current === generation) loading.value = false }
}
watch(() => props.workspace.id, () => {
  form.value = { email:'',membershipRole:'member',businessRole:'recruiter',departmentId:null,expiresInDays:7 }
  memberForms.value = {}
  void load()
}, { immediate:true })
function editable(member: WorkspaceMember) { return member.id !== authSession.user?.id && member.membershipRole !== 'owner' && (owner.value || member.membershipRole !== 'admin') }
async function create() {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const current = generation
    const invitation = await createInvitation(props.workspace.id,{...form.value})
    if (current !== generation) return
    invitations.value.unshift(invitation); created.value = invitation
    notice.value = '邀请已生成。请复制邀请码或邀请链接发给同事。'
  } catch (cause) { error.value = describeApiFailure(cause,'生成邀请失败').message }
  finally { busy.value = false }
}
async function copy(text: string) {
  try { await copyText(text); notice.value = '已复制，可粘贴到钉钉、微信或邮件中发送' }
  catch (cause) { error.value = describeApiFailure(cause,'复制失败，请手动选中复制').message }
}
async function share(invitation: Invitation) {
  try {
    if (!navigator.share) { await copy(invitationText(invitation)); return }
    await navigator.share({title:'加入「'+invitation.workspaceName+'」',text:invitationText(invitation),url:invitationLink(invitation.code ?? '')})
    notice.value = '邀请已交给系统分享面板，请在面板中确认发送'
  } catch (cause) { if (!(cause instanceof Error && cause.name === 'AbortError')) error.value = describeApiFailure(cause,'分享失败，可复制邀请内容发送').message }
}
function email(invitation: Invitation) {
  window.location.href = 'mailto:' + encodeURIComponent(invitation.email ?? '') + '?subject=' + encodeURIComponent('邀请加入「'+invitation.workspaceName+'」') + '&body=' + encodeURIComponent(invitationText(invitation))
  notice.value = '已请求打开本机邮件编辑器，请检查收件人并自行点击发送；平台未自动发送邮件。'
}
async function revoke(invitation: Invitation) {
  if (busy.value || !window.confirm('撤销此邀请？撤销后原邀请码和链接将立即失效。')) return
  busy.value = true; error.value = ''
  try { const current = generation
    await revokeInvitation(props.workspace.id,invitation.id)
    if (current !== generation) return
    invitation.status = 'revoked'; if(created.value?.id===invitation.id) created.value=null; notice.value='邀请已撤销' }
  catch (cause) { error.value = describeApiFailure(cause,'撤销失败').message }
  finally { busy.value = false }
}
async function save(member: WorkspaceMember) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const current = generation
    const saved = {...memberForms.value[member.id]!}
    await updateWorkspaceMember(props.workspace.id,member.id,saved)
    if (current !== generation) return
    member.membershipRole = saved.membershipRole; member.businessRole = saved.businessRole; member.departmentId = saved.departmentId ?? null
    notice.value='成员权限已保存，将在该成员后续请求中生效；不影响其他企业的角色。'
  } catch (cause) { error.value=describeApiFailure(cause,'保存成员权限失败').message }
  finally { busy.value=false }
}
</script>
<template>
  <section class="manager" aria-labelledby="invitation-manager-title" :aria-busy="loading">
    <header><div><h2 id="invitation-manager-title">{{ workspace.name }} · 成员与邀请</h2><p>一次性邀请、企业级角色；仅企业所有者可邀请和调整企业管理员。</p></div><button type="button" :disabled="busy || loading" @click="load">刷新</button></header>
    <div v-if="error" class="message error" role="alert">{{ error }}</div><div v-if="notice" class="message notice" role="status">{{ notice }}</div>
    <p v-if="loading">正在加载成员与邀请…</p>
    <template v-else>

      <form class="invite-form" @submit.prevent="create">
        <label>接收邮箱（可选）<input v-model="form.email" type="email" maxlength="254" placeholder="填写后仅该邮箱可加入" /></label>
        <label>企业身份<select v-model="form.membershipRole"><option value="member">普通成员</option><option v-if="owner" value="admin">企业管理员</option></select></label>
        <label>业务角色<select v-model="form.businessRole"><option v-for="role in ['recruiter','hiring_manager','approver','interviewer']" :key="role" :value="role">{{ businessRoleLabels[role] }}</option></select></label>
        <label>所属部门<select v-model="form.departmentId"><option :value="null">{{ form.businessRole === 'hiring_manager' ? '请选择部门（必填）' : '未指定部门' }}</option><option v-for="dept in departments" :key="dept.id" :value="dept.id">{{ dept.name }}</option></select></label>
        <label>有效期<select v-model="form.expiresInDays"><option v-for="days in [1,3,7,30]" :key="days" :value="days">{{ days }} 天</option></select></label>
        <button class="primary" type="submit" :disabled="busy">{{ busy ? '处理中…' : '生成邀请' }}</button>
      </form>
      <p class="tip">不填写邮箱的邀请可由任何获得邀请码的人使用，请仅发给可信同事。这里的企业管理员不是平台系统管理员，不会获得全局系统配置权限。</p>
      <p v-if="localOnly" class="tip">当前是本机地址，邀请链接只能在本机打开。同事需通过平台的局域网或公网地址登录，再输入邀请码；要直接分享可访问的链接，请从该地址打开平台后复制。</p>
      <div v-if="created" class="created"><strong>新邀请码</strong><code>{{ created.code }}</code><button type="button" @click="copy(created.code ?? '')">复制邀请码</button><button type="button" @click="copy(invitationLink(created.code ?? ''))">复制邀请链接</button><button type="button" @click="copy(invitationText(created))">复制邀请内容</button><button type="button" @click="share(created)">分享 / 发送邀请</button><button type="button" @click="email(created)">邮件邀请（本机）</button><p>邮箱密码登录 → 验证邀请 → 确认加入。有效期至 {{ new Date(created.expiresAt).toLocaleString('zh-CN') }}。</p></div>
      <h3>邀请记录 <small>{{ invitations.length }} 条（最多展示最近 200 条）</small></h3>
      <p v-if="!invitations.length">还没有邀请，先生成一个发给同事。</p>
      <div class="table-scroll"><table v-if="invitations.length"><thead><tr><th>接收人 / 邀请码</th><th>权限</th><th>有效期 / 状态</th><th>操作</th></tr></thead><tbody><tr v-for="item in invitations" :key="item.id"><td>{{ item.email || '不限接收邮箱' }}<code>{{ item.code }}</code></td><td>{{ membershipLabels[item.membershipRole] }}<br />{{ businessRoleLabels[item.businessRole] }} {{ item.departmentName ? '· '+item.departmentName : '' }}</td><td>{{ new Date(item.expiresAt).toLocaleString('zh-CN') }}<br /><span class="status" :class="item.status">{{ statuses[item.status] }}</span></td><td><div v-if="item.status === 'pending'" class="actions"><button type="button" @click="copy(item.code ?? '')">复制码</button><button type="button" @click="copy(invitationLink(item.code ?? ''))">复制链接</button><button type="button" @click="share(item)">发送邀请</button><button type="button" @click="email(item)">邮件</button><button type="button" :disabled="busy" @click="revoke(item)">撤销</button></div><span v-else>—</span></td></tr></tbody></table></div>
      <h3>企业成员 <small>{{ members.length }} 人</small></h3>
      <div class="table-scroll"><table><thead><tr><th>成员</th><th>企业身份</th><th>业务角色</th><th>所属部门</th><th>操作</th></tr></thead><tbody><tr v-for="member in members" :key="member.id"><td>{{ member.name }}<small>{{ member.email }}</small></td><td><select v-if="editable(member)" :aria-label="member.name + '的企业身份'" v-model="memberForms[member.id]!.membershipRole"><option value="member">普通成员</option><option v-if="owner" value="admin">企业管理员</option></select><span v-else>{{ membershipLabels[member.membershipRole] }}</span></td><td><select v-if="editable(member)" :aria-label="member.name + '的业务角色'" v-model="memberForms[member.id]!.businessRole"><option v-for="role in ['recruiter','hiring_manager','approver','interviewer']" :key="role" :value="role">{{ businessRoleLabels[role] }}</option></select><span v-else>{{ businessRoleLabels[member.businessRole] || member.businessRole }}</span></td><td><select v-if="editable(member)" :aria-label="member.name + '的所属部门'" v-model="memberForms[member.id]!.departmentId"><option :value="null">未指定部门</option><option v-for="dept in departments" :key="dept.id" :value="dept.id">{{ dept.name }}</option></select><span v-else>{{ member.departmentName || '未指定' }}</span></td><td><button v-if="editable(member)" type="button" :disabled="busy" @click="save(member)">保存权限</button><span v-else>{{ member.id === authSession.user?.id ? '当前账号' : '—' }}</span></td></tr></tbody></table></div>
      <details class="role-guide" aria-label="企业身份与业务角色说明">
        <summary>企业身份与业务角色说明</summary>
        <p>企业身份用于管理空间与成员；业务角色用于区分招聘工作。企业管理员身份不代表自动获得录用审批权。</p>
        <ul>
          <li><b>招聘专员：</b>日常岗位、简历与面试工作。</li>
          <li><b>部门负责人：</b>负责部门招聘，需指定所属部门。</li>
          <li><b>录用审批人：</b>用于录用、薪资与 Offer 审批；具体操作仍受任务分配和后端权限校验约束。</li>
          <li><b>面试官：</b>参与面试并提交反馈。</li>
        </ul>
        <p>不同企业的成员身份独立设置；更改角色不会自动替你审批或发放 Offer。</p>
      </details>
    </template>
  </section>
</template>
<style scoped>
.role-guide { margin-top:16px; padding:14px 16px; border:1px solid #cce6df; border-radius:12px; background:#effaf6; font-size:12px; line-height:1.8; }.role-guide summary { cursor:pointer; font-weight:600; }.role-guide p { margin:6px 0; }.role-guide ul { margin:8px 0; padding-left:20px; }
.manager { margin-top:26px; padding:22px; border:1px solid #d8e5f3; border-radius:19px; background:#f3f8ffb3; color:#365d71; }header { display:flex; justify-content:space-between; align-items:start; gap:12px; }h2 { margin:0; font-size:18px; } h3 { font-size:15px; margin-top:24px; } p,small { font-size:12px; color:#6d8794; line-height:1.8; }h3 small { font-weight:normal; } .invite-form { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-top:18px; align-items:end; }label { display:grid; gap:7px; font-size:12px; }input,select { width:100%; min-width:0; box-sizing:border-box; padding:10px; border:1px solid #cfdeeb; border-radius:9px; background:#ffffffc9; color:#365d71; font:inherit; }button { border:1px solid #c5dce8; border-radius:9px; background:#fff; color:#36768b; padding:8px 11px; cursor:pointer; font:inherit; font-size:12px; }button:disabled { opacity:.55; cursor:wait; }.primary { padding:11px; background:#4a91c9; color:white; border-color:transparent; }.created { padding:16px; display:flex; flex-wrap:wrap; gap:10px; align-items:center; background:#eefaf5; border:1px solid #cce9dd; border-radius:13px; }.created p { margin:0; width:100%; }code { display:block; color:#367b86; font-size:12px; user-select:all; margin-top:5px; overflow-wrap:anywhere; }.created code { font-size:16px; margin:0; }table { width:100%; border-collapse:collapse; font-size:12px; }th,td { text-align:left; padding:12px 8px; border-bottom:1px solid #dbe6ef; vertical-align:top; }td small { display:block; overflow-wrap:anywhere; }.actions { display:flex; flex-wrap:wrap; gap:5px; }.table-scroll { overflow:auto; }.status { display:inline-block; margin-top:5px; border-radius:5px; padding:2px 6px; background:#e7eef4; }.pending { background:#e1f4ee; color:#378374; }.message { padding:10px; border-radius:8px; margin-top:12px; font-size:13px; }.error { background:#fff0f3; color:#af4f66; }.notice { background:#e8f7ef; color:#397d60; }input:focus-visible,select:focus-visible,button:focus-visible { outline:3px solid #64adce55; outline-offset:2px; }@media(max-width:700px) { .invite-form { grid-template-columns:1fr; }.manager { padding:16px; }table { min-width:600px; } }
</style>
