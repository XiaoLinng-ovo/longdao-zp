<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowLeft, Check, KeyRound, Mail, X } from '@lucide/vue'
import { changePasswordWithCode, confirmEmailChange, requestAccountPasswordCode, requestEmailChangeCode, verifyAccountPasswordCode } from '../api'
import { authSession, clearCredentialChangeSession } from '../session'
import { describeApiFailure } from '../../../shared/utils/errorMessage'

const props = defineProps<{ kind: 'email' | 'password' }>()
const emit = defineEmits<{ close: []; complete: [kind: 'email' | 'password'] }>()
const dialog = ref<HTMLDialogElement>()
const step = ref<'address' | 'code' | 'password' | 'success'>('address')
const email = ref(''), code = ref(''), password = ref(''), repeat = ref(''), error = ref('')
const busy = ref(false), retry = ref(0)
const target = computed(() => props.kind === 'email' ? email.value.trim().toLowerCase() : authSession.user?.email ?? '')
const title = computed(() => props.kind === 'email' ? '更换邮箱' : '修改密码')
const completedEmail = ref('')
const sessionId = authSession.sessionId
let timer: ReturnType<typeof setInterval> | undefined
let previousFocus: HTMLElement | null = null
let disposed = false
function sessionChanged() {
  if (disposed) return true
  if (authSession.sessionId === sessionId) return false
  emit('close')
  return true
}
function focusField() { void nextTick(() => dialog.value?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus()) }
onMounted(() => {
  previousFocus = document.activeElement as HTMLElement | null
  if (dialog.value?.showModal) dialog.value.showModal()
  else dialog.value?.setAttribute('open', '')
  focusField()
})
onBeforeUnmount(() => {
  disposed = true
  if (timer) clearInterval(timer)
  code.value = password.value = repeat.value = ''
  dialog.value?.close?.()
  previousFocus?.focus?.()
})
function close() {
  if (busy.value) return
  if (step.value === 'success') emit('complete', props.kind)
  else emit('close')
}
async function sendCode() {
  if (busy.value || retry.value) return
  error.value = ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(target.value) || (props.kind === 'email' && target.value === authSession.user?.email.toLowerCase())) {
    error.value = '请输入与当前登录邮箱不同的有效邮箱'; return
  }
  busy.value = true
  try {
    const result = props.kind === 'email' ? await requestEmailChangeCode(target.value) : await requestAccountPasswordCode()
    if (sessionChanged()) return
    code.value = ''; step.value = 'code'
    const deadline = Date.now() + result.retryAfterSeconds * 1000
    retry.value = result.retryAfterSeconds
    if (timer) clearInterval(timer)
    timer = setInterval(() => { retry.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) }, 1000)
    focusField()
  } catch (cause) { if (!sessionChanged()) error.value = describeApiFailure(cause, '验证码发送失败').message }
  finally { busy.value = false }
}
async function submit() {
  if (busy.value) return
  if (step.value === 'address') return sendCode()
  if (!/^\d{6}$/u.test(code.value)) { error.value = '请输入邮件中的 6 位验证码'; return }
  if (props.kind === 'password' && step.value === 'code') {
    busy.value = true; error.value = ''
    try {
      await verifyAccountPasswordCode(code.value)
      if (sessionChanged()) return
      step.value = 'password'; focusField()
    } catch (cause) { if (!sessionChanged()) error.value = describeApiFailure(cause, '验证码校验失败').message }
    finally { busy.value = false }
    return
  }
  if (props.kind === 'password' && (password.value.length < 8 || password.value.length > 128 || password.value !== repeat.value)) {
    error.value = password.value !== repeat.value ? '两次输入的新密码不一致' : '新密码需为 8 至 128 个字符'; return
  }
  busy.value = true; error.value = ''
  try {
    if (props.kind === 'email') await confirmEmailChange(target.value, undefined, code.value)
    else await changePasswordWithCode(code.value, password.value)
    if (sessionChanged()) return
    completedEmail.value = target.value
    if (props.kind === 'email' && authSession.user) authSession.user.email = target.value
    code.value = password.value = repeat.value = ''
    step.value = 'success'
    clearCredentialChangeSession()
  } catch (cause) { if (!sessionChanged()) error.value = describeApiFailure(cause, '修改失败，请重试').message }
  finally { busy.value = false }
}
function back() { step.value = props.kind === 'password' && step.value === 'password' ? 'code' : 'address'; error.value = ''; code.value = ''; focusField() }
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="credential-dialog" :aria-label="title" @cancel.prevent="close">
      <header><h2><Mail v-if="kind === 'email'" :size="20" /><KeyRound v-else :size="20" />{{ title }}</h2><button type="button" class="icon-button" aria-label="关闭" title="关闭" :disabled="busy" @click="close"><X :size="20" /></button></header>
      <form v-if="step !== 'success'" @submit.prevent="submit">
        <ol class="steps" aria-label="更换进度"><li :aria-current="step === 'address' ? 'step' : undefined">1. {{ kind === 'email' ? '填写新邮箱' : '确认邮箱' }}</li><li :aria-current="step === 'code' ? 'step' : undefined">2. 邮箱验证码</li><li v-if="kind === 'password'" :aria-current="step === 'password' ? 'step' : undefined">3. 设置密码</li></ol>
        <div class="fields">
          <template v-if="step === 'address'">
            <label v-if="kind === 'email'">新邮箱<input v-model="email" type="email" autocomplete="email" maxlength="254" required :disabled="busy" /></label>
            <template v-else><p>验证码将发送至当前登录邮箱</p><strong class="destination">{{ target }}</strong></template>
            <p>验证完成后更新登录凭据，所有已登录设备需要重新登录。</p>
          </template>
          <template v-else-if="step === 'code'">
            <p role="status">验证码已发送至 <strong class="destination">{{ target }}</strong>，10 分钟内有效。</p>
            <label>{{ kind === 'email' ? '新邮箱验证码' : '邮箱验证码' }}<input v-model.trim="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required :disabled="busy" /></label>
            <button class="text-button" type="button" :disabled="busy || retry > 0" @click="sendCode">{{ retry ? `${retry} 秒后重新发送` : '重新发送验证码' }}</button>
          </template>
          <template v-else>
            <label>新密码<input v-model="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required :disabled="busy" /></label>
            <label>确认新密码<input v-model="repeat" type="password" autocomplete="new-password" minlength="8" maxlength="128" required :disabled="busy" /></label><p>新密码需为 8 至 128 个字符。</p>
          </template>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
        </div>
        <footer><button v-if="step !== 'address'" type="button" class="secondary" :disabled="busy" @click="back"><ArrowLeft :size="16" />上一步</button><button type="submit" class="primary" :disabled="busy || (step === 'code' && !/^\d{6}$/u.test(code)) || (step === 'address' && retry > 0)">{{ busy ? '处理中...' : step === 'address' ? '发送验证码' : step === 'password' ? '确认修改密码' : kind === 'email' ? '验证并更换' : '下一步' }}</button></footer>
      </form>
      <div v-else class="success" role="status"><Check :size="32" /><h3>{{ title }}成功</h3><p v-if="kind === 'email'">登录邮箱已更新为 <strong class="destination">{{ completedEmail }}</strong></p><p>请使用{{ kind === 'email' ? '新邮箱和原密码' : '新密码' }}重新登录。</p><button type="button" class="primary" @click="close">重新登录</button></div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.credential-dialog { position: fixed; inset: 0; width: min(460px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; box-sizing: border-box; border: 1px solid #d7e5eb; border-radius: 8px; padding: 0; background: #fff; color: #2e5064; box-shadow: 0 16px 64px #172b3c30; }
.credential-dialog::backdrop { background: #17304766; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid #edf2f5; padding: 16px 20px; }
h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 17px; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 38px; border: 1px solid transparent; border-radius: 6px; padding: 8px 14px; font: inherit; font-size: 13px; cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible { outline: 2px solid #3985d8; outline-offset: 2px; }
.icon-button { width: 32px; min-height: 32px; padding: 0; background: transparent; color: #58778a; }
.steps { display: flex; flex-wrap: wrap; gap: 8px 14px; margin: 0; padding: 18px 20px 0; list-style: none; font-size: 12px; color: #718798; }
.steps [aria-current] { color: #236cb8; font-weight: 700; }
.fields { display: grid; gap: 16px; padding: 22px 20px; }
label { display: grid; gap: 8px; font-size: 13px; }
input { width: 100%; min-width: 0; min-height: 42px; box-sizing: border-box; border: 1px solid #d7e5eb; border-radius: 6px; padding: 8px 12px; background: #fbfdfe; color: #2e5064; font: inherit; }
input:focus { outline: 2px solid #70bdc2; outline-offset: 1px; }
p { margin: 0; color: #6b8291; font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.destination { overflow-wrap: anywhere; color: #31556a; }
.text-button { justify-self: start; min-height: 32px; padding: 0; background: transparent; color: #236cb8; }
.error { padding: 9px 12px; border-radius: 6px; background: #fff3f3; color: #a63847; }
footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; border-top: 1px solid #edf2f5; padding: 14px 20px; }
.primary { background: #3985d8; color: white; }
.primary:hover:not(:disabled) { background: #2b73c2; }
.secondary { background: #f7fafc; border-color: #d7e5eb; color: #46667a; }
.success { display: grid; justify-items: center; gap: 16px; padding: 28px 24px; text-align: center; }
.success > svg { color: #34856c; }
h3 { margin: 0; font-size: 18px; }
</style>
