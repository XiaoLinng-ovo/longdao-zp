<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { getSecurityConfig, register, requestRegistrationCode } from '../api'
import { switchWorkspace, syncAuthenticatedSession } from '../session'
import TurnstileWidget from '../components/TurnstileWidget.vue'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { getInvitationSummary, type SharedInvitationSummary } from '../api/invitations'
import { extractInvitationCode } from '../utils/invitations'
import { safeAuthRedirect } from '../utils/redirect'


const router = useRouter()
const route = useRoute()
const invitationContext = computed(() => {
  if ('invite' in route.query) return typeof route.query.invite === 'string' ? route.query.invite : ''
  const redirect = safeAuthRedirect(route.query.redirect)
  if (!redirect || !/^\/(?:join|workspaces)(?:[?#]|$)/.test(redirect)) return undefined
  return new URL(redirect, window.location.origin).searchParams.get('invite') ?? undefined
})
const invited = computed(() => invitationContext.value !== undefined)
const inviteCode = computed(() => extractInvitationCode(invitationContext.value ?? ''))
const invitation = ref<SharedInvitationSummary | null>(null)
const invitationLoading = ref(false)
const companyName = ref('')
const name = ref('')
const email = ref('')
const phone = ref('')
const password = ref('')
const confirmPassword = ref('')
const verificationCode = ref('')
const error = ref('')
const notice = ref('')
const submitting = ref(false)
const sendingCode = ref(false)
const step = ref<1 | 2>(1)
const countdown = ref(0)
const turnstileEnabled = ref(false)
const turnstileSiteKey = ref('')
const codeTurnstileToken = ref('')
const confirmTurnstileToken = ref('')
const codeTurnstileResetKey = ref(0)
const confirmTurnstileResetKey = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | undefined

const codeButtonLabel = computed(() => {
  if (sendingCode.value) return '发送中...'
  return countdown.value > 0 ? `${countdown.value}s 后重发` : '重新发送验证码'
})

function startCountdown(seconds: number) {
  if (countdownTimer) clearInterval(countdownTimer)
  countdown.value = Math.max(1, seconds)
  countdownTimer = setInterval(() => {
    countdown.value = Math.max(0, countdown.value - 1)
    if (countdown.value === 0 && countdownTimer) {
      clearInterval(countdownTimer)
      countdownTimer = undefined
    }
  }, 1000)
}

function validateAccountFields(): boolean {
  if (invited.value && !invitation.value) { error.value = '邀请尚未验证或已失效，请重新打开邀请链接'; return false }
  if ((!invited.value && !companyName.value.trim()) || !name.value.trim() || !email.value.trim() || !password.value) {
    error.value = invited.value ? '请填写姓名、邮箱和密码' : '请填写企业名称、姓名、邮箱和密码'
    return false
  }
  if (!invited.value && companyName.value.trim().length < 2) { error.value = '企业名称至少需要 2 个字符'; return false }
  if (password.value.length < 8) { error.value = '密码至少需要 8 个字符'; return false }
  if (password.value !== confirmPassword.value) { error.value = '两次输入的密码不一致'; return false }
  return true
}

async function sendCode(isResend = false) {
  if (sendingCode.value || countdown.value > 0) return
  error.value = ''
  if (!isResend && !validateAccountFields()) return
  if (!email.value.trim()) { error.value = '请先填写邮箱'; return }
  if (turnstileEnabled.value && !codeTurnstileToken.value) { error.value = '请先完成人机验证'; return }
  sendingCode.value = true
  try {
    const result = await requestRegistrationCode(email.value.trim(), codeTurnstileToken.value || undefined)
    step.value = 2
    verificationCode.value = ''
    notice.value = isResend ? '新的验证码已发送，请查收邮箱。' : '验证码已发送至邮箱，请在 10 分钟内完成注册。'
    startCountdown(result.retryAfterSeconds)
  } catch (cause) {
    error.value = describeApiFailure(cause, '验证码发送失败').message
  } finally {
    sendingCode.value = false
    codeTurnstileToken.value = ''
    codeTurnstileResetKey.value += 1
    confirmTurnstileToken.value = ''
    confirmTurnstileResetKey.value += 1
  }
}

async function submitRegistration() {
  if (submitting.value || !validateAccountFields()) return
  error.value = ''
  if (!/^\d{6}$/u.test(verificationCode.value.replace(/\s+/gu, ''))) { error.value = '请输入 6 位邮箱验证码'; return }
  if (turnstileEnabled.value && !confirmTurnstileToken.value) { error.value = '请先完成人机验证'; return }
  submitting.value = true
  try {
    const registered = await register({
      companyName: invited.value ? '' : companyName.value.trim(),
      ...(invited.value ? {invitationCode:inviteCode.value} : {}),
      name: name.value.trim(),
      email: email.value.trim(),
      password: password.value,
      verificationCode: verificationCode.value.replace(/\s+/gu, ''),
      ...(phone.value.trim() ? { phone: phone.value.trim() } : {}),
      ...(confirmTurnstileToken.value ? { turnstileToken: confirmTurnstileToken.value } : {}),
    })
    confirmTurnstileToken.value = ''
    const workspaces = syncAuthenticatedSession(registered)
    const redirect = typeof route.query.redirect === 'string' && /^\/workspaces(?:[?#]|$)/.test(route.query.redirect) ? route.query.redirect : undefined
    if (invited.value) {
      try { await switchWorkspace(registered.workspace.id); window.location.assign('/') }
      catch { await router.push({name:'invitation-join',query:{invite:inviteCode.value}}) }
    } else if (redirect) {
      await router.push(redirect)
    } else if (workspaces.length === 1 && workspaces[0]?.id === registered.workspace.id) {
      await switchWorkspace(registered.workspace.id)
      await router.push('/')
    } else {
      await router.push('/workspaces')
    }
  } catch (cause) {
    error.value = describeApiFailure(cause, '注册失败').message
  } finally {
    submitting.value = false
    confirmTurnstileToken.value = ''
    confirmTurnstileResetKey.value += 1
  }
}

function setTurnstileError(message: string) {
  error.value = message
}

function editAccount() {
  step.value = 1
  error.value = ''
  notice.value = ''
}

let invitationGeneration = 0
watch(invitationContext, async () => {
  const current = ++invitationGeneration
  invitation.value = null; step.value = 1; error.value = ''
  if (!invited.value) return
  invitationLoading.value = true
  try { const result = await getInvitationSummary(inviteCode.value); if (current === invitationGeneration) invitation.value = result }
  catch (cause) { if (current === invitationGeneration) error.value = describeApiFailure(cause, '邀请已失效').message }
  finally { if (current === invitationGeneration) invitationLoading.value = false }
}, { immediate:true })

onMounted(async () => {
  try {
    const config = await getSecurityConfig()
    turnstileEnabled.value = config.turnstileEnabled
    turnstileSiteKey.value = config.turnstileSiteKey
  } catch {
    // Keep the form usable when optional anti-bot configuration cannot be loaded.
  }
})

onBeforeUnmount(() => {
  if (countdownTimer) clearInterval(countdownTimer)
})
</script>

<template>
  <main class="register-shell">
    <section class="register-card">
      <div class="register-brand"><span>龙道</span><div><b>{{ invited ? '注册并加入企业' : '注册企业账号' }}</b><small>{{ invited ? invitation?.workspaceName : '注册账号并创建企业工作区' }}</small></div></div>
      <div class="register-heading">
        <div class="register-step-label">步骤 {{ step }} / 2</div>
        <h1>{{ step === 1 ? (invited ? '注册并加入企业' : '创建企业账号') : '验证你的邮箱' }}</h1>
        <p>{{ step === 1 ? (invited ? '填写个人信息，验证邮箱后加入受邀企业。' : '填写企业和个人信息，我们会向邮箱发送一次性验证码。') : `验证码已发送至 ${email}。` }}</p>
      </div>
      <div class="register-progress" aria-hidden="true"><span :class="{ complete: step === 2 }"></span><i></i><span :class="{ active: step === 2 }"></span></div>
      <div v-if="error" class="register-error" role="alert">{{ error }}</div>
      <div v-if="notice" class="register-notice" role="status">{{ notice }}</div>
      <form v-if="step === 1" class="register-form" @submit.prevent="sendCode(false)">
        <div v-if="invited" class="register-account-summary">{{ invitationLoading ? '正在验证企业邀请...' : invitation ? '加入企业：' + invitation.workspaceName : '邀请不可用' }}</div>
        <label v-else>企业名称<input v-model="companyName" autocomplete="organization" placeholder="例如：龙道科技" /></label>
        <label>姓名<input v-model="name" autocomplete="name" placeholder="请输入姓名" /></label>
        <label>邮箱<input v-model="email" type="email" autocomplete="email" placeholder="name@company.com" /></label>
        <label>手机号（可选）<input v-model="phone" type="tel" autocomplete="tel" placeholder="用于账号支持" /></label>
        <label>密码<input v-model="password" type="password" autocomplete="new-password" placeholder="至少 8 个字符" /></label>
        <label>确认密码<input v-model="confirmPassword" type="password" autocomplete="new-password" placeholder="再次输入密码" /></label>
        <TurnstileWidget v-if="turnstileEnabled" v-model="codeTurnstileToken" :site-key="turnstileSiteKey" action="register-code" :reset-key="codeTurnstileResetKey" @error="setTurnstileError" />
        <button class="register-submit" type="submit" :disabled="sendingCode || (invited && !invitation)">{{ sendingCode ? '发送验证码...' : '发送邮箱验证码' }}</button>
      </form>
      <form v-else class="register-form register-code-form" @submit.prevent="submitRegistration">
        <div class="register-account-summary">
          <span>{{ invited ? invitation?.workspaceName : companyName }} · {{ name }}</span>
          <button type="button" @click="editAccount">修改资料</button>
        </div>
        <label>邮箱验证码<input v-model="verificationCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="输入 6 位验证码" /></label>
        <TurnstileWidget v-if="turnstileEnabled" v-model="confirmTurnstileToken" :site-key="turnstileSiteKey" action="register-confirm" :reset-key="confirmTurnstileResetKey" @error="setTurnstileError" />
        <button class="register-submit" type="submit" :disabled="submitting">{{ submitting ? '正在完成注册...' : invited ? '验证并加入企业' : '验证并完成注册' }}</button>
        <button class="resend-code" type="button" :disabled="sendingCode || countdown > 0" @click="sendCode(true)">{{ codeButtonLabel }}</button>
      </form>
      <div class="register-flow"><span>{{ invited ? '填写个人信息' : '填写企业信息' }}</span><i>→</i><span>验证邮箱</span><i>→</i><span>{{ invited ? '加入企业' : '创建企业' }}</span></div>
      <router-link class="back-login" :to="{ name: 'login', query: invited ? {redirect:'/join?invite=' + encodeURIComponent(inviteCode)} : route.query.redirect ? { redirect: route.query.redirect } : {} }">已有账号？返回登录</router-link>
    </section>
  </main>
</template>

<style scoped>
.register-shell { min-height: 100vh; display: grid; place-items: center; padding: 28px 16px; background: radial-gradient(circle at 20% 10%, #e5f8f4, transparent 34%), linear-gradient(135deg, #f5fbfc, #edf4fb); }
.register-card { width: min(100%, 510px); padding: 31px; border: 1px solid rgba(151, 194, 209, .35); border-radius: 22px; background: rgba(255,255,255,.94); box-shadow: 0 20px 55px rgba(59, 101, 130, .14); }
.register-brand { display: flex; align-items: center; gap: 11px; color: #27546c; }.register-brand > span { display:grid; place-items:center; width:39px; height:39px; border-radius: 12px; background: linear-gradient(135deg,#54c3b8,#5e91e4); color:#fff; font-weight: 800; }.register-brand div { display:grid; gap:3px; }.register-brand b { font-size:15px; }.register-brand small { color:#88a0ad; font-size:10.5px; }
.register-heading { margin: 20px 0 13px; }.register-step-label { display:inline-flex; margin-bottom:9px; padding:4px 8px; border-radius:99px; background:#eaf5f7; color:#4f8794; font-size:10px; font-weight:700; }.register-heading h1 { margin:0; color:#22485d; font-size:25px; }.register-heading p { margin:8px 0 0; color:#79919f; font-size:12px; line-height:1.7; }.register-progress { display:grid; grid-template-columns:18px 1fr 18px; align-items:center; gap:7px; margin-bottom:16px; }.register-progress span { width:18px; height:18px; border:3px solid #dce8ed; border-radius:50%; background:#fff; }.register-progress span.complete { border-color:#3fb4ad; background:#3fb4ad; }.register-progress span.active { border-color:#4e91df; box-shadow:0 0 0 4px rgba(78,145,223,.12); }.register-progress i { height:2px; background:#dce8ed; }.register-error, .register-notice { margin-bottom:13px; padding:9px 11px; border:1px solid #f0cbd0; border-radius:9px; background:#fff4f5; color:#bb5c6a; font-size:12px; line-height:1.6; }.register-notice { border-color:#c6e5df; background:#f1faf8; color:#357b73; }
.register-form { display:grid; gap:13px; }.register-form label { display:grid; gap:6px; color:#567287; font-size:12px; }.register-form input { box-sizing:border-box; width:100%; min-height:42px; border:1px solid #d8e7ed; border-radius:10px; padding:0 12px; outline:0; color:#31566a; background:#fbfdfe; }.register-form input:focus { border-color:#60bfc2; box-shadow:0 0 0 4px rgba(96,191,194,.13); }.register-submit { min-height:43px; margin-top:4px; border:0; border-radius:11px; background:linear-gradient(135deg,#37b7b6,#4c8ee7); color:#fff; font-weight:700; cursor:pointer; }.register-submit:disabled { opacity:.6; cursor:wait; }
.register-account-summary { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 11px; border:1px solid #dce9ed; border-radius:9px; background:#f7fafb; color:#456579; font-size:11.5px; }.register-account-summary span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.register-account-summary button, .resend-code { border:0; background:transparent; color:#368c92; font:inherit; cursor:pointer; }.resend-code { min-height:34px; }.register-account-summary button:hover, .resend-code:hover:not(:disabled) { text-decoration:underline; }.resend-code:disabled { color:#9aadb7; cursor:not-allowed; }
.register-flow { display:flex; justify-content:center; flex-wrap:wrap; gap:7px; margin-top:19px; color:#8299a6; font-size:10.5px; }.register-flow i { color:#aec1ca; font-style:normal; }.back-login { display:block; margin-top:18px; color:#398c94; text-align:center; font-size:11.5px; text-decoration:none; }.back-login:hover { text-decoration:underline; }
@media (max-width: 520px) { .register-card { padding:23px 18px; } .register-heading h1 { font-size:22px; } }
</style>
