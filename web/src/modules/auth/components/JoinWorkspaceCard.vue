<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { acceptInvitation, previewInvitation, type Invitation } from '../api/invitations'
import { switchWorkspace } from '../session'
import { businessRoleLabels, extractInvitationCode, membershipLabels } from '../utils/invitations'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
const emit = defineEmits<{ joined: [] }>()
const route = useRoute()
const code = ref('')
const preview = ref<Invitation | null>(null)
const checkedCode = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')
watch(() => route.query.invite, value => { if (typeof value === 'string') code.value = extractInvitationCode(value) }, { immediate: true })
watch(code, () => { preview.value = null; error.value = ''; notice.value = '' })
async function paste() {
  try { code.value = extractInvitationCode(await navigator.clipboard.readText()) }
  catch { error.value = '浏览器未允许读取剪贴板，请点击输入框，使用 Ctrl+V 或长按粘贴' }
}
async function check() {
  if (busy.value) return
  busy.value = true; error.value = ''; preview.value = null; notice.value = ''
  try {
    const normalized = extractInvitationCode(code.value)
    if (!/^[A-F0-9]{24}$/.test(normalized)) throw new Error('请输入完整的 24 位邀请码，或粘贴完整邀请链接')
    checkedCode.value = normalized
    const result = await previewInvitation(normalized)
    if (extractInvitationCode(code.value) === normalized) preview.value = result
  } catch (cause) { error.value = describeApiFailure(cause, '无法读取邀请').message }
  finally { busy.value = false }
}
async function join() {
  if (busy.value || !preview.value || checkedCode.value !== extractInvitationCode(code.value)) return
  busy.value = true; error.value = ''
  try {
    const joined = await acceptInvitation(checkedCode.value)
    preview.value = null
    try {
      await switchWorkspace(joined.workspaceId)
      notice.value = '已加入「' + joined.workspaceName + '」，当前已切换到该企业'
    } catch {
      notice.value = '已成功加入「' + joined.workspaceName + '」，但自动切换失败。请在下方我的企业列表中点击进入，不需要再次使用邀请码。'
    }
    emit('joined')
  } catch (cause) { error.value = describeApiFailure(cause, '加入企业失败').message }
  finally { busy.value = false }
}
</script>
<template>
  <section class="join-card" aria-labelledby="join-title">
    <div><h2 id="join-title">使用邀请码加入企业</h2><p>邀请码用于加入企业，不代替邮箱密码登录。每个邀请码仅可使用一次。</p></div>
    <form class="join-form" @submit.prevent="check">
      <label class="sr-only" for="workspace-invite-code">邀请码或邀请链接</label>
      <input id="workspace-invite-code" v-model="code" :disabled="busy" placeholder="输入邀请码或粘贴邀请链接" autocomplete="off" maxlength="2048" />
      <button type="button" :disabled="busy" @click="paste">粘贴</button>
      <button type="submit" :disabled="busy || !code.trim()">{{ busy ? '处理中…' : '验证邀请码' }}</button>
    </form>
    <div v-if="error" class="join-error" role="alert">{{ error }}</div>
    <div v-if="notice" class="join-success" role="status">{{ notice }}</div>
    <div v-if="preview" class="join-preview">
      <strong>{{ preview.workspaceName }}</strong>
      <span>{{ preview.workspaceKind === 'test' ? '测试企业' : '正式企业' }} · {{ membershipLabels[preview.membershipRole] }} · {{ businessRoleLabels[preview.businessRole] }}</span>
      <span v-if="preview.departmentName">所属部门：{{ preview.departmentName }}</span>
      <small>有效期至 {{ new Date(preview.expiresAt).toLocaleString('zh-CN') }}；确认后加入并切换到该企业。</small>
      <button type="button" :disabled="busy" @click="join">确认加入企业</button>
    </div>
  </section>
</template>
<style scoped>
.join-card { margin-top:24px; padding:22px; border:1px solid #cde8e3; border-radius:19px; background:linear-gradient(125deg,#edf9f5cc,#f0f7ffcc); }
h2 { margin:0; font-size:17px; color:#245769; } p,small { color:#64818e; font-size:12px; line-height:1.8; } p { margin:8px 0 14px; }
.join-form { display:flex; gap:8px; flex-wrap:wrap; } input { flex:1; min-width:200px; border:1px solid #cce1e7; border-radius:10px; padding:11px; font:inherit; font-size:13px; background:#ffffffb0; }
button { border:1px solid #bcdde1; background:#fff; border-radius:10px; color:#2a7886; padding:10px 14px; cursor:pointer; font:inherit; font-size:12px; } button[type=submit],.join-preview button { background:#368fa4; color:white; border-color:transparent; } button:disabled { opacity:.5; cursor:wait; }
.join-preview { display:grid; gap:8px; margin-top:14px; padding:16px; background:#ffffffa8; border-radius:12px; color:#345d6e; font-size:13px; } .join-preview button { justify-self:start; }
.join-error,.join-success { margin-top:12px; font-size:13px; color:#ad4158; } .join-success { color:#24775b; }.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
input:focus-visible,button:focus-visible { outline:3px solid #67b9c766; outline-offset:2px; }
</style>
