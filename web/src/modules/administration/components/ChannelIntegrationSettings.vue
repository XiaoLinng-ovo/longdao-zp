<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  getChannelSettings,
  testChannelConnection,
  updateChannelSettings,
  type ChannelOperationResult,
  type ChannelProvider,
  type ChannelSettings,
  type ChannelSettingsView,
} from '../api'

const settings = ref<ChannelSettings | null>(null)
const loading = ref(true)
const saving = ref(false)
const testingProvider = ref<ChannelProvider | null>(null)
const error = ref('')
const feedback = ref('')
const drafts = ref<Record<string, Record<string, string>>>({})
const enabled = ref<Record<string, boolean>>({})
const testResults = ref<Record<string, ChannelOperationResult>>({})

function buildDrafts(next: ChannelSettings) {
  drafts.value = Object.fromEntries(Object.values(next).map((provider) => [
    provider.id,
    Object.fromEntries(provider.fields.map((field) => [
      field.key,
      field.secret ? '' : provider.values[field.key]?.value ?? '',
    ])),
  ]))
  enabled.value = Object.fromEntries(Object.values(next).map((provider) => [provider.id, provider.enabled]))
  testResults.value = {}
}

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const next = await getChannelSettings()
    settings.value = next
    buildDrafts(next)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取渠道配置失败'
  } finally {
    loading.value = false
  }
}

function providers(): ChannelSettingsView[] {
  return settings.value ? Object.values(settings.value) : []
}

function patchPayload(): Record<string, string> {
  const patch: Record<string, string> = {}
  for (const provider of providers()) {
    for (const field of provider.fields) {
      if (field.connectionKey === 'enabled') {
        patch[field.key] = String(Boolean(enabled.value[provider.id]))
        continue
      }
      const value = drafts.value[provider.id]?.[field.key]?.trim() ?? ''
      if (field.secret && !value) continue
      patch[field.key] = value
    }
  }
  return patch
}

async function save() {
  saving.value = true
  error.value = ''
  feedback.value = ''
  try {
    const next = await updateChannelSettings(patchPayload())
    settings.value = next
    buildDrafts(next)
    feedback.value = '渠道配置已保存，密钥不会在页面回显。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存渠道配置失败'
  } finally {
    saving.value = false
  }
}

async function test(provider: ChannelProvider) {
  testingProvider.value = provider
  error.value = ''
  feedback.value = ''
  try {
    testResults.value = { ...testResults.value, [provider]: await testChannelConnection(provider) }
  } catch (cause) {
    testResults.value = {
      ...testResults.value,
      [provider]: { status: 'error', message: cause instanceof Error ? cause.message : '测试连接失败' },
    }
  } finally {
    testingProvider.value = null
  }
}

function statusLabel(provider: ChannelSettingsView): string {
  if (provider.configured) return '配置完整'
  if (provider.enabled) return '待补充配置'
  return '未启用'
}

function statusClass(provider: ChannelSettingsView): string {
  if (provider.configured) return 'is-configured'
  if (provider.enabled) return 'is-pending'
  return 'is-disabled'
}

onMounted(refresh)
</script>

<template>
  <section class="section">
    <div class="section-heading">
      <div>
        <h3 class="section-title">招聘渠道接入</h3>
        <p class="muted">先保存各平台开放接口配置；未取得官方接口文档前，测试会明确显示未实现，不会伪造连接成功。</p>
      </div>
      <button class="btn btn-primary" type="button" :disabled="saving || loading" @click="save">{{ saving ? '保存中...' : '保存渠道配置' }}</button>
    </div>
    <div v-if="loading" class="loading-note">正在读取招聘渠道配置...</div>
    <p v-else-if="error" class="error-note" role="alert">{{ error }}</p>
    <p v-if="feedback" class="muted" role="status">{{ feedback }}</p>
    <div v-if="settings" class="channel-grid">
      <article v-for="provider in providers()" :key="provider.id" class="channel-card">
        <header>
          <div>
            <h4>{{ provider.name }}</h4>
            <p>{{ provider.description }}</p>
          </div>
          <span class="channel-status" :class="statusClass(provider)">{{ statusLabel(provider) }}</span>
        </header>
        <div class="channel-fields">
          <div v-for="field in provider.fields" :key="field.key" class="form-field">
            <label :for="`${provider.id}-${field.key}`">
              {{ field.label }}
              <span v-if="field.required" class="required">*</span>
              <code>{{ field.key }}</code>
            </label>
            <label v-if="field.connectionKey === 'enabled'" class="channel-switch">
              <input :id="`${provider.id}-${field.key}`" v-model="enabled[provider.id]" type="checkbox" />
              <span>{{ enabled[provider.id] ? '已启用' : '未启用' }}</span>
            </label>
            <input
              v-else
              :id="`${provider.id}-${field.key}`"
              v-model="drafts[provider.id][field.key]"
              :type="field.secret ? 'password' : 'text'"
              :placeholder="field.secret && provider.values[field.key]?.configured ? '已配置，留空表示不修改' : field.placeholder || '未配置'"
              autocomplete="new-password"
            />
            <small>{{ field.help }}</small>
          </div>
        </div>
        <footer>
          <button class="btn btn-ghost" type="button" :disabled="testingProvider === provider.id" @click="test(provider.id)">{{ testingProvider === provider.id ? '测试中...' : '测试连接' }}</button>
          <p v-if="testResults[provider.id]" class="channel-test-result" :class="`is-${testResults[provider.id]?.status}`">{{ testResults[provider.id]?.message }}</p>
        </footer>
      </article>
    </div>
  </section>
</template>

<style scoped>
.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}
.muted {
  color: var(--muted, #64748b);
  font-size: 12.5px;
}
.channel-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 12px;
}
.channel-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: #fff;
  box-shadow: var(--shadow);
}
.channel-card > header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 15px 16px;
  border-bottom: 1px solid var(--border);
}
.channel-card h4 {
  margin: 0;
  color: #1e293b;
  font-size: 14px;
}
.channel-card header p {
  margin: 5px 0 0;
  color: var(--muted, #64748b);
  font-size: 12px;
}
.channel-status {
  align-self: flex-start;
  padding: 3px 8px;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 11.5px;
  white-space: nowrap;
}
.channel-status.is-configured { background: #dcfce7; color: #15803d; }
.channel-status.is-pending { background: #fef3c7; color: #b45309; }
.channel-status.is-disabled { background: #f1f5f9; color: #64748b; }
.channel-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 11px;
  padding: 15px 16px;
}
.channel-fields .form-field:first-child,
.channel-fields .form-field:last-child {
  grid-column: 1 / -1;
}
.form-field label code {
  margin-left: 5px;
  color: #94a3b8;
  font-size: 10px;
}
.form-field small {
  display: block;
  margin-top: 5px;
  color: #94a3b8;
  line-height: 1.5;
}
.channel-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  color: #475569;
  font-size: 12.5px;
}
.channel-card > footer {
  margin-top: auto;
  padding: 12px 16px 15px;
  border-top: 1px solid var(--border);
}
.channel-test-result {
  margin: 9px 0 0;
  color: #475569;
  font-size: 12px;
  line-height: 1.5;
}
.channel-test-result.is-ok { color: #15803d; }
.channel-test-result.is-error { color: #b91c1c; }
.channel-test-result.is-not_configured,
.channel-test-result.is-not_implemented { color: #b45309; }
@media (max-width: 980px) {
  .channel-grid { grid-template-columns: 1fr; }
}
@media (max-width: 700px) {
  .section-heading { flex-direction: column; }
  .channel-fields { grid-template-columns: 1fr; }
  .channel-fields .form-field { grid-column: auto; }
}
</style>
