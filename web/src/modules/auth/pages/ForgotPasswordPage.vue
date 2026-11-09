<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { confirmPasswordReset, getSecurityConfig, requestPasswordResetCode } from '../api'
import TurnstileWidget from '../components/TurnstileWidget.vue'
import { describeApiFailure } from '../../../shared/utils/errorMessage'

const router = useRouter()
const email = ref('')
const verificationCode = ref('')
const password = ref('')
const confirmPassword = ref('')
const showPassword = ref(false)
const error = ref('')
const notice = ref('')
const step = ref<1 | 2>(1)
const sendingCode = ref(false)
const submitting = ref(false)
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

function resetCodeTurnstile() {
  codeTurnstileToken.value = ''
  codeTurnstileResetKey.value += 1
}

function resetConfirmTurnstile() {
  confirmTurnstileToken.value = ''
  confirmTurnstileResetKey.value += 1
}

async function sendCode(isResend = false) {
  if (sendingCode.value || countdown.value > 0) return
  error.value = ''
  if (!email.value.trim()) {
    error.value = '请输入注册邮箱'
    return
  }
  if (turnstileEnabled.value && !codeTurnstileToken.value) {
    error.value = '请先完成人机验证'
    return
  }
  sendingCode.value = true
  notice.value = ''
  try {
    const result = await requestPasswordResetCode(email.value.trim(), codeTurnstileToken.value || undefined)
    step.value = 2
    verificationCode.value = ''
    notice.value = isResend ? '新的验证码已发送，请查收邮箱。' : '如果该邮箱已注册，验证码会发送到对应邮箱。'
    startCountdown(result.retryAfterSeconds)
  } catch (cause) {
    error.value = describeApiFailure(cause, '验证码发送失败').message
  } finally {
    sendingCode.value = false
    resetCodeTurnstile()
    resetConfirmTurnstile()
  }
}

async function submitReset() {
  if (submitting.value) return
  error.value = ''
  if (!/^\d{6}$/u.test(verificationCode.value.replace(/\s+/gu, ''))) {
    error.value = '请输入 6 位邮箱验证码'
    return
  }
  if (password.value.length < 8) {
    error.value = '密码至少需要 8 个字符'
    return
  }
  if (password.value !== confirmPassword.value) {
    error.value = '两次输入的密码不一致'
    return
  }
  if (turnstileEnabled.value && !confirmTurnstileToken.value) {
    error.value = '请先完成人机验证'
    return
  }
  submitting.value = true
  try {
    await confirmPasswordReset(
      email.value.trim(),
      verificationCode.value.replace(/\s+/gu, ''),
      password.value,
      confirmTurnstileToken.value || undefined,
    )
    await router.push({ name: 'login', query: { reset: '1' } })
  } catch (cause) {
    error.value = describeApiFailure(cause, '密码重置失败').message
  } finally {
    submitting.value = false
    resetConfirmTurnstile()
  }
}

function editEmail() {
  step.value = 1
  verificationCode.value = ''
  error.value = ''
  notice.value = ''
  resetConfirmTurnstile()
}

function setTurnstileError(message: string) {
  error.value = message
}

onMounted(async () => {
  try {
    const config = await getSecurityConfig()
    turnstileEnabled.value = config.turnstileEnabled
    turnstileSiteKey.value = config.turnstileSiteKey
  } catch {
    // The API remains the source of truth for validation if optional configuration cannot load.
  }
})

onBeforeUnmount(() => {
  if (countdownTimer) clearInterval(countdownTimer)
})
</script>

<template>
  <main class="forgot-shell">
    <section class="forgot-card">
      <div class="forgot-brand"><span>龙道</span><div><b>找回账号密码</b><small>通过邮箱验证码重新设置登录密码</small></div></div>
      <div class="forgot-heading">
        <div class="forgot-step-label">步骤 {{ step }} / 2</div>
        <h1>{{ step === 1 ? '验证注册邮箱' : '设置新密码' }}</h1>
        <p>{{ step === 1 ? '我们会向已注册邮箱发送一次性验证码。' : `验证码已发送至 ${email}，10 分钟内有效。密码重置后，其他已登录会话将失效。` }}</p>
      </div>
      <div class="forgot-progress" aria-hidden="true"><span :class="{ active: step === 1, complete: step === 2 }"></span><i></i><span :class="{ active: step === 2 }"></span></div>
      <div v-if="error" class="forgot-error" role="alert">{{ error }}</div>
      <div v-if="notice" class="forgot-notice" role="status">{{ notice }}</div>

      <form v-if="step === 1" class="forgot-form" @submit.prevent="sendCode(false)">
        <label>注册邮箱<input v-model="email" type="email" autocomplete="email" placeholder="name@company.com" /></label>
        <TurnstileWidget
          v-if="turnstileEnabled"
          v-model="codeTurnstileToken"
          :site-key="turnstileSiteKey"
          action="password-reset"
          :reset-key="codeTurnstileResetKey"
          @error="setTurnstileError"
        />
        <button class="forgot-submit" type="submit" :disabled="sendingCode">{{ sendingCode ? '发送验证码...' : '发送验证码' }}</button>
      </form>

      <form v-else class="forgot-form" @submit.prevent="submitReset">
        <div class="forgot-email-summary"><span>{{ email }}</span><button type="button" @click="editEmail">修改邮箱</button></div>
        <label>邮箱验证码<input v-model="verificationCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="输入 6 位验证码" /></label>
        <label>新密码
          <div class="forgot-password-input">
            <input v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" placeholder="至少 8 个字符" />
            <button type="button" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button>
          </div>
        </label>
        <label>确认新密码<input v-model="confirmPassword" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" placeholder="再次输入新密码" /></label>
        <TurnstileWidget
          v-if="turnstileEnabled"
          v-model="confirmTurnstileToken"
          :site-key="turnstileSiteKey"
          action="password-reset-confirm"
          :reset-key="confirmTurnstileResetKey"
          @error="setTurnstileError"
        />
        <button class="forgot-submit" type="submit" :disabled="submitting">{{ submitting ? '正在重置...' : '重置密码' }}</button>
        <button class="forgot-resend" type="button" :disabled="sendingCode || countdown > 0" @click="sendCode(true)">{{ codeButtonLabel }}</button>
      </form>

      <router-link class="back-login" :to="{ name: 'login' }">返回登录</router-link>
    </section>
  </main>
</template>

<style scoped>
.forgot-shell { min-height: 100vh; display: grid; place-items: center; padding: 28px 16px; background: radial-gradient(circle at 20% 10%, #e5f8f4, transparent 34%), linear-gradient(135deg, #f5fbfc, #edf4fb); }
.forgot-card { box-sizing: border-box; width: min(100%, 500px); padding: 31px; border: 1px solid rgba(151, 194, 209, .35); border-radius: 22px; background: rgba(255, 255, 255, .95); box-shadow: 0 20px 55px rgba(59, 101, 130, .14); }
.forgot-brand { display: flex; align-items: center; gap: 11px; color: #27546c; }
.forgot-brand > span { display: grid; place-items: center; width: 39px; height: 39px; border-radius: 12px; background: linear-gradient(135deg, #54c3b8, #5e91e4); color: #fff; font-weight: 800; }
.forgot-brand div { display: grid; gap: 3px; }
.forgot-brand b { font-size: 15px; }
.forgot-brand small { color: #88a0ad; font-size: 10.5px; }
.forgot-heading { margin: 20px 0 13px; }
.forgot-step-label { display: inline-flex; margin-bottom: 9px; padding: 4px 8px; border-radius: 99px; background: #eaf5f7; color: #4f8794; font-size: 10px; font-weight: 700; }
.forgot-heading h1 { margin: 0; color: #22485d; font-size: 25px; }
.forgot-heading p { margin: 8px 0 0; overflow-wrap: anywhere; color: #79919f; font-size: 12px; line-height: 1.7; }
.forgot-progress { display: grid; grid-template-columns: 18px 1fr 18px; align-items: center; gap: 7px; margin-bottom: 16px; }
.forgot-progress span { width: 18px; height: 18px; border: 3px solid #dce8ed; border-radius: 50%; background: #fff; }
.forgot-progress span.complete { border-color: #3fb4ad; background: #3fb4ad; }
.forgot-progress span.active { border-color: #4e91df; box-shadow: 0 0 0 4px rgba(78, 145, 223, .12); }
.forgot-progress i { height: 2px; background: #dce8ed; }
.forgot-error, .forgot-notice { margin-bottom: 13px; padding: 9px 11px; border: 1px solid #f0cbd0; border-radius: 9px; background: #fff4f5; color: #bb5c6a; font-size: 12px; line-height: 1.6; }
.forgot-notice { border-color: #c6e5df; background: #f1faf8; color: #357b73; }
.forgot-form { display: grid; gap: 13px; }
.forgot-form label { display: grid; gap: 6px; color: #567287; font-size: 12px; }
.forgot-form input { box-sizing: border-box; width: 100%; min-height: 42px; padding: 0 12px; border: 1px solid #d8e7ed; border-radius: 10px; outline: 0; color: #31566a; background: #fbfdfe; }
.forgot-form input:focus { border-color: #60bfc2; box-shadow: 0 0 0 4px rgba(96, 191, 194, .13); }
.forgot-password-input { position: relative; }
.forgot-password-input input { padding-right: 56px; }
.forgot-password-input button { position: absolute; top: 0; right: 5px; height: 42px; padding: 0 8px; border: 0; background: transparent; color: #438f96; font-size: 11px; cursor: pointer; }
.forgot-submit { min-height: 43px; margin-top: 4px; border: 0; border-radius: 11px; background: linear-gradient(135deg, #37b7b6, #4c8ee7); color: #fff; font-weight: 700; cursor: pointer; }
.forgot-submit:disabled { opacity: .6; cursor: wait; }
.forgot-email-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 11px; border: 1px solid #dce9ed; border-radius: 9px; background: #f7fafb; color: #456579; font-size: 11.5px; }
.forgot-email-summary span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.forgot-email-summary button, .forgot-resend { border: 0; background: transparent; color: #368c92; font: inherit; cursor: pointer; }
.forgot-resend { min-height: 32px; }
.forgot-email-summary button:hover, .forgot-resend:hover:not(:disabled) { text-decoration: underline; }
.forgot-resend:disabled { color: #9aadb7; cursor: not-allowed; }
.back-login { display: block; margin-top: 18px; color: #398c94; text-align: center; font-size: 11.5px; text-decoration: none; }
.back-login:hover { text-decoration: underline; }
@media (max-width: 520px) { .forgot-card { padding: 23px 18px; } .forgot-heading h1 { font-size: 22px; } }
</style>
