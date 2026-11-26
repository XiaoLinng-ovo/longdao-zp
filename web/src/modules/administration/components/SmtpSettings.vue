<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  getSmtpSettings,
  sendSmtpTestEmail,
  testSmtpConnection,
  updateSmtpSettings,
  type SmtpEnvSettings,
} from '../api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'

const settings = ref<SmtpEnvSettings | null>(null)
const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const sendingTestEmail = ref(false)
const error = ref('')
const result = ref('')
const testRecipient = ref('')
const draft = reactive({ host: '', port: '465', secure: true, user: '', password: '', fromEmail: '', fromName: '' })

const configured = computed(() => settings.value ? Object.values(settings.value).every((item) => item.configured) : false)

function splitFrom(value: string) {
  const match = value.match(/^\s*(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/u)
  return match ? { email: match[2]!, name: match[1]!.replace(/^['"]|['"]$/gu, '') } : { email: value.trim(), name: '' }
}

function fromValue() {
  const email = draft.fromEmail.trim()
  const name = draft.fromName.trim()
  return name ? `${name} <${email}>` : email
}

function applySettings(value: SmtpEnvSettings) {
  settings.value = value
  draft.host = value.SMTP_HOST.value
  draft.port = value.SMTP_PORT.value || '465'
  draft.secure = value.SMTP_SECURE.value === 'true'
  draft.user = value.SMTP_USER.value
  draft.password = ''
  const from = splitFrom(value.SMTP_FROM.value)
  draft.fromEmail = from.email
  draft.fromName = from.name
}

function requestPatch() {
  return {
    SMTP_HOST: draft.host.trim(),
    SMTP_PORT: draft.port.trim(),
    SMTP_SECURE: String(draft.secure),
    SMTP_USER: draft.user.trim(),
    SMTP_FROM: fromValue(),
    ...(draft.password.trim() ? { SMTP_PASSWORD: draft.password } : {}),
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    applySettings(await getSmtpSettings())
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取 SMTP 配置失败').message
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  error.value = ''
  result.value = ''
  try {
    applySettings(await updateSmtpSettings(requestPatch()))
    result.value = 'SMTP 配置已保存'
  } catch (cause) {
    error.value = describeApiFailure(cause, '保存 SMTP 配置失败').message
  } finally {
    saving.value = false
  }
}

async function testConnection() {
  testing.value = true
  error.value = ''
  result.value = ''
  try {
    const response = await testSmtpConnection(requestPatch())
    result.value = response.message
    if (!response.ok) error.value = response.message
  } catch (cause) {
    error.value = describeApiFailure(cause, 'SMTP 连接测试失败').message
  } finally {
    testing.value = false
  }
}

async function sendTestEmail() {
  sendingTestEmail.value = true
  error.value = ''
  result.value = ''
  try {
    const response = await sendSmtpTestEmail(testRecipient.value.trim())
    result.value = response.message
  } catch (cause) {
    error.value = describeApiFailure(cause, '发送测试邮件失败').message
  } finally {
    sendingTestEmail.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="smtp-settings section">
    <div class="smtp-card">
      <header class="smtp-card-header">
        <div>
          <h3>SMTP 设置</h3>
          <p>配置用于发送 Offer 和招聘通知的邮件服务</p>
        </div>
        <div class="inline-actions">
          <button class="btn btn-ghost" type="button" :disabled="loading || testing || saving" @click="testConnection">{{ testing ? '测试中...' : '测试连接' }}</button>
          <button class="btn btn-primary" type="button" :disabled="loading || saving || testing" @click="save">{{ saving ? '保存中...' : '保存配置' }}</button>
        </div>
      </header>

      <div class="smtp-card-body">
        <p v-if="error" class="smtp-feedback error" role="alert">{{ error }}</p>
        <p v-else-if="result" class="smtp-feedback success" role="status">{{ result }}</p>
        <p v-if="loading" class="loading-note">正在读取 SMTP 配置...</p>

        <div v-else class="smtp-form-grid">
          <div class="smtp-field"><label for="smtp-host">SMTP 主机</label><input id="smtp-host" v-model="draft.host" autocomplete="off" placeholder="smtp.example.com" /></div>
          <div class="smtp-field"><label for="smtp-port">SMTP 端口</label><input id="smtp-port" v-model="draft.port" inputmode="numeric" autocomplete="off" placeholder="465" /></div>
          <div class="smtp-field"><label for="smtp-user">SMTP 用户名</label><input id="smtp-user" v-model="draft.user" autocomplete="username" placeholder="sender@example.com" /></div>
          <div class="smtp-field"><label for="smtp-password">SMTP 密码</label><input id="smtp-password" v-model="draft.password" type="password" autocomplete="new-password" :placeholder="settings?.SMTP_PASSWORD.configured ? '已配置，留空保留当前值' : '请输入 SMTP 授权密码'" /><small v-if="settings?.SMTP_PASSWORD.configured">密码已配置，留空保留当前值。</small></div>
          <div class="smtp-field"><label for="smtp-from-email">发件人邮箱</label><input id="smtp-from-email" v-model="draft.fromEmail" autocomplete="email" placeholder="sender@example.com" /></div>
          <div class="smtp-field"><label for="smtp-from-name">发件人名称</label><input id="smtp-from-name" v-model="draft.fromName" autocomplete="organization" placeholder="例如：招聘团队" /></div>
        </div>

        <div v-if="!loading" class="tls-row">
          <div><strong>使用 TLS</strong><span>为 SMTP 连接启用 TLS 加密</span></div>
          <label class="toggle" title="为 SMTP 连接启用 TLS 加密"><input v-model="draft.secure" type="checkbox" role="switch" /><span class="toggle-track"></span></label>
        </div>
      </div>
      <footer v-if="!loading" class="smtp-card-footer"><span :class="configured ? 'configuration-status configured' : 'configuration-status'">{{ configured ? 'SMTP 配置已完成' : '请补全全部字段后保存' }}</span></footer>
    </div>

    <div class="smtp-card test-email-card">
      <header class="smtp-card-header">
        <div><h3>发送测试邮件</h3><p>使用已保存的 SMTP 配置验证邮件发送能力</p></div>
      </header>
      <div class="smtp-card-body test-email-body">
        <div class="smtp-field"><label for="smtp-test-recipient">收件人邮箱</label><input id="smtp-test-recipient" v-model="testRecipient" type="email" autocomplete="email" placeholder="test@example.com" @keyup.enter="sendTestEmail" /></div>
        <button class="btn btn-primary send-test-button" type="button" :disabled="loading || sendingTestEmail || !testRecipient.trim()" @click="sendTestEmail">{{ sendingTestEmail ? '发送中...' : '发送测试邮件' }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.smtp-settings { display: grid; gap: 22px; max-width: 1120px; }
.smtp-card { overflow: hidden; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 3px 12px rgb(15 23 42 / 6%); }
.smtp-card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 20px 24px 16px; border-bottom: 1px solid #edf2f7; }
.smtp-card-header h3 { margin: 0; color: #1e293b; font-size: 17px; line-height: 1.35; }
.smtp-card-header p { margin: 5px 0 0; color: #64748b; font-size: 13px; line-height: 1.5; }
.smtp-card-body { padding: 24px; }
.smtp-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 24px; }
.smtp-field { min-width: 0; }
.smtp-field label { display: block; margin-bottom: 8px; color: #334155; font-size: 13px; font-weight: 600; }
.smtp-field input { box-sizing: border-box; width: 100%; min-height: 42px; padding: 9px 12px; border: 1px solid #d8e0ea; border-radius: 8px; background: #fff; color: #1e293b; font-size: 14px; outline: none; transition: border-color .15s ease, box-shadow .15s ease; }
.smtp-field input::placeholder { color: #94a3b8; }
.smtp-field input:focus { border-color: var(--primary, #0f766e); box-shadow: 0 0 0 3px var(--primary-bg, #ccfbf1); }
.smtp-field small { display: block; margin-top: 6px; color: #64748b; font-size: 12px; }
.tls-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 24px; padding-top: 18px; border-top: 1px solid #edf2f7; }
.tls-row strong { display: block; color: #1e293b; font-size: 15px; }
.tls-row span { display: block; margin-top: 4px; color: #64748b; font-size: 13px; }
.toggle { display: inline-flex; flex: none; cursor: pointer; }
.toggle input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.toggle-track { position: relative; display: block; width: 44px; height: 24px; border-radius: 999px; background: #cbd5e1; transition: background .15s ease; }
.toggle-track::after { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgb(15 23 42 / 18%); content: ''; transition: transform .15s ease; }
.toggle input:checked + .toggle-track { background: var(--primary, #0f766e); }
.toggle input:checked + .toggle-track::after { transform: translateX(20px); }
.toggle input:focus-visible + .toggle-track { outline: 3px solid var(--primary-bg, #ccfbf1); outline-offset: 2px; }
.smtp-card-footer { display: flex; justify-content: flex-end; padding: 12px 24px; border-top: 1px solid #edf2f7; background: #f8fafc; }
.configuration-status { color: #64748b; font-size: 12px; }
.configuration-status.configured { color: #15803d; }
.smtp-feedback { margin: 0 0 18px; padding: 10px 12px; border-radius: 8px; font-size: 13px; }
.smtp-feedback.success { border: 1px solid #bbf7d0; background: #f0fdf4; color: #15803d; }
.smtp-feedback.error { border: 1px solid #fecaca; background: #fef2f2; color: #b91c1c; }
.test-email-card { margin: 0; }
.test-email-body { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 16px; }
.send-test-button { min-height: 42px; white-space: nowrap; }
@media (max-width: 720px) { .smtp-card-header { flex-direction: column; padding: 18px; } .smtp-card-body { padding: 18px; } .smtp-form-grid, .test-email-body { grid-template-columns: 1fr; } .smtp-card-footer { padding: 12px 18px; justify-content: flex-start; } .send-test-button { width: 100%; } }
</style>