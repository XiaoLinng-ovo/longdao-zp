<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Check, PlugZap, RefreshCw, Save, Trash2, X } from '@lucide/vue'
import PageHeader from '../../../shared/components/PageHeader.vue'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { authSession } from '../../auth/session'
import AiModelSelector from '../components/AiModelSelector.vue'
import { getEnterpriseAiSettings, selectEnterpriseAiSource, saveEnterpriseAiSettings, testEnterpriseAiConnection, type AiSettings, type AiConnectionTestResult } from '../api'

const settings = ref<AiSettings | null>(null)
const modelSource = ref<'enterprise' | 'platform'>('enterprise')
const apiKey = ref('')
const model = ref('')
const models = ref<string[]>([])
const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const confirmingReset = ref(false)
const error = ref('')
const notice = ref('')
const testResult = ref<AiConnectionTestResult | null>(null)
const busy = computed(() => loading.value || saving.value || testing.value)
const enterpriseName = computed(() => authSession.workspaces.find(item => item.id === authSession.user?.workspaceId)?.name ?? '当前企业')

async function load() {
  loading.value = true
  error.value = ''
  try {
    settings.value = await getEnterpriseAiSettings()
    model.value = settings.value.model
    modelSource.value = settings.value.modelSource ?? 'enterprise'
    apiKey.value = ''
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取 AI 配置失败').message
  } finally { loading.value = false }
}

async function testConnection() {
  if (busy.value) return
  testing.value = true
  error.value = ''
  notice.value = ''
  models.value = []
  testResult.value = null
  try {
    testResult.value = await testEnterpriseAiConnection(apiKey.value.trim() ? { OPENAI_API_KEY: apiKey.value.trim() } : {})
    models.value = testResult.value.ok ? testResult.value.models : []
  } catch (cause) {
    error.value = describeApiFailure(cause, '连接测试失败').message
  } finally { testing.value = false }
}

async function save(reset = false) {
  if (busy.value) return
  error.value = ''
  notice.value = ''
  if (!reset && (!model.value.trim() || (!apiKey.value.trim() && !settings.value?.apiKeyConfigured))) {
    error.value = '请填写 API Key 并选择模型'
    return
  }
  saving.value = true
  try {
    settings.value = await saveEnterpriseAiSettings(reset ? { OPENAI_API_KEY: '' } : {
      OPENAI_MODEL: model.value.trim(),
      ...(apiKey.value.trim() ? { OPENAI_API_KEY: apiKey.value.trim() } : {}),
    })
    apiKey.value = ''
    model.value = settings.value.model
    confirmingReset.value = false
    testResult.value = null
    models.value = []
    notice.value = reset ? '已清除企业密钥，企业自配模型已不可用' : 'AI 模型配置已保存'
  } catch (cause) {
    error.value = describeApiFailure(cause, '保存 AI 配置失败').message
  } finally { saving.value = false }
}

function clearConnectionResult() {
  models.value = []
  testResult.value = null
}

async function saveSource() {
  if (busy.value) return
  saving.value = true; error.value = ''; notice.value = ''
  try { settings.value = await selectEnterpriseAiSource(modelSource.value); notice.value = '企业模型来源已更新' }
  catch (cause) { error.value = describeApiFailure(cause, '切换模型来源失败').message }
  finally { saving.value = false }
}

onMounted(load)
</script>

<template>
  <PageHeader title="AI 模型配置" :description="enterpriseName" />
  <section class="ai-settings section">
    <div class="section-heading">
      <h3 class="section-title">模型连接</h3>
      <span class="config-state">{{ settings?.modelSource === 'platform' ? (settings.platformAuthorized ? '平台授权模型' : '平台授权已撤回') : settings?.configured ? '企业配置' : '企业模型未配置' }}</span>
    </div>
    <p v-if="error" class="feedback failure" role="alert">{{ error }}</p>
    <p v-if="notice" class="feedback success" role="status">{{ notice }}</p>
    <p v-if="loading" class="muted" role="status">正在读取模型配置...</p>
    <button v-else-if="!settings" class="btn btn-ghost" type="button" @click="load"><RefreshCw :size="16" />重新加载</button>
    <template v-else>
    <form class="source-form" @submit.prevent="saveSource">
      <label for="enterprise-ai-source">模型来源</label>
      <select id="enterprise-ai-source" v-model="modelSource" :disabled="busy">
        <option value="enterprise">企业配置</option>
        <option value="platform" :disabled="!settings.platformAuthorized">平台授权模型{{ settings.platformAuthorized ? '' : '（未授权）' }}</option>
      </select>
      <button class="btn btn-primary" type="submit" :disabled="busy || modelSource === settings.modelSource"><Save :size="16" />保存来源</button>
    </form>
    <form v-if="modelSource === 'enterprise'" @submit.prevent="save()">
      <div class="form-field endpoint-field">
        <label>API 接口地址</label>
        <code data-testid="fixed-ai-endpoint">{{ settings.env.OPENAI_BASE_URL.value }}</code>
      </div>
      <div class="form-field">
        <label for="enterprise-ai-key">API Key</label>
        <input id="enterprise-ai-key" v-model="apiKey" type="password" :disabled="busy" :placeholder="settings.apiKeyConfigured ? '已配置，留空保留原密钥' : '请输入 API Key'" autocomplete="new-password" spellcheck="false" @input="clearConnectionResult" />
      </div>
      <div class="form-field">
        <label for="enterprise-ai-model">模型</label>
        <AiModelSelector id="enterprise-ai-model" v-model="model" :options="models" :disabled="busy" />
      </div>
      <p v-if="testResult" class="feedback" :class="testResult.ok ? 'success' : 'failure'" role="status">{{ testResult.message }}（{{ testResult.latencyMs }} 毫秒）</p>
      <div class="actions">
        <button class="btn btn-ghost" type="button" :disabled="busy || (!apiKey.trim() && !settings.apiKeyConfigured)" @click="testConnection"><PlugZap :size="16" />{{ testing ? '测试中...' : '测试连接' }}</button>
        <button class="btn btn-primary" type="submit" :disabled="busy"><Save :size="16" />{{ saving ? '保存中...' : '保存配置' }}</button>
        <button v-if="settings.apiKeyConfigured && !confirmingReset" class="btn btn-ghost reset-button" type="button" :disabled="busy" @click="confirmingReset = true"><Trash2 :size="16" />清除企业密钥</button>
      </div>
      <div v-if="confirmingReset" class="reset-confirmation" role="alert">
        <span>清除当前企业的 API Key？清除后企业自配模型将不可用。</span>
        <button class="btn btn-danger" type="button" :disabled="busy" @click="save(true)"><Check :size="16" />确认清除</button>
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="confirmingReset = false"><X :size="16" />取消</button>
      </div>
    </form>
    </template>
  </section>
</template>

<style scoped>
.source-form{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:20px 0}.source-form select{padding:9px;border:1px solid #cbd5d1;border-radius:6px;font:inherit}.source-form button{display:inline-flex;gap:7px;align-items:center}.ai-settings{max-width:840px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.config-state{font-size:13px;color:#526b62}.form-field{display:flex;flex-direction:column;gap:8px;margin:22px 0;min-width:0}.form-field label{font-size:14px;font-weight:600}.form-field input{box-sizing:border-box;width:100%;min-width:0;padding:10px 12px;border:1px solid #cbd5d1;border-radius:6px;font:inherit;font-size:14px}.form-field input:focus-visible{outline:2px solid #5f9d8a;outline-offset:2px}.endpoint-field code{overflow-wrap:anywhere;color:#42594f;font-size:14px}.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.actions .btn,.reset-confirmation .btn{display:inline-flex;gap:7px;align-items:center;justify-content:center;min-height:38px}.reset-button{margin-left:auto}.feedback{font-size:14px;line-height:1.6;overflow-wrap:anywhere}.failure{color:#a72e40}.success{color:#287456}.reset-confirmation{display:flex;align-items:center;flex-wrap:wrap;gap:12px;border-top:1px solid #e1e6e3;margin-top:24px;padding-top:20px}.reset-confirmation span{flex:1 1 100%;font-size:14px}@media(max-width:600px){.reset-button{margin-left:0}.actions{gap:8px}}
</style>
