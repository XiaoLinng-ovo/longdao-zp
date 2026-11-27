<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { RefreshCw } from '@lucide/vue'
import { diagnoseAi, importLegacyAi, previewLegacyAi, probeAiGeneration, type AiDiagnosis, type AiGenerationProbe, type AiMigrationPreview } from '../api/ai-maintenance'

const props = defineProps<{ refreshKey?: string }>()
const emit = defineEmits<{ migrated: [] }>()
const diagnosis = ref<AiDiagnosis | null>(null), probe = ref<AiGenerationProbe | null>(null)
const loading = ref(false), busy = ref(false), error = ref(''), notice = ref('')
const selected = ref<AiMigrationPreview | null>(null), confirmed = ref(false)
const destination = ref('')
const sources = {platform:'平台统一配置',enterprise:'企业自备配置',legacy_enterprise:'历史企业共享配置'}
const errors: Record<string,string> = {
  PLATFORM_AI_NOT_CONFIGURED:'平台统一配置缺失',AI_SECRET_DECRYPTION_FAILED:'密钥解密失败',AI_ENCRYPTION_KEY_UNAVAILABLE:'加密主密钥不可用',
  AI_ENDPOINT_NOT_ALLOWED:'模型地址不在允许范围',AI_ENDPOINT_POLICY_REQUIRED:'模型地址策略未配置',ENTERPRISE_AI_NOT_CONFIGURED:'企业模型配置不完整',
  AI_PROVIDER_HTTP_ERROR:'模型服务返回错误',AI_PROVIDER_INVALID_RESPONSE:'模型未返回有效文本',AI_PROVIDER_UNAVAILABLE:'模型连接失败或超时',
}
const describe = (code: string | null) => code ? errors[code] ?? code : ''
async function load() {
  loading.value=true; error.value=''; probe.value=null; selected.value=null; confirmed.value=false
  try { diagnosis.value=await diagnoseAi() }
  catch (cause) { error.value=cause instanceof Error ? cause.message : '读取模型诊断失败' }
  finally { loading.value=false }
}
async function testGeneration() {
  busy.value=true; error.value=''; probe.value=null
  try { probe.value=await probeAiGeneration() }
  catch (cause) { error.value=cause instanceof Error ? cause.message : '真实生成测试失败' }
  finally { busy.value=false }
}
async function migrate() {
  if (!selected.value?.canMigrate || !confirmed.value || busy.value) return
  busy.value=true; error.value=''; notice.value=''
  try {
    await importLegacyAi(selected.value)
    notice.value='配置已迁入平台，原企业配置及授权范围保持不变'
    await load(); emit('migrated')
  } catch (cause) { error.value=cause instanceof Error ? cause.message : '配置迁移失败，未覆盖平台配置' }
  finally { busy.value=false }
}
async function updatePreview() {
  if (!selected.value || busy.value) return
  busy.value=true; error.value=''; confirmed.value=false
  try { selected.value=await previewLegacyAi(selected.value.sourceOrganizationId,destination.value.trim()) }
  catch (cause) { error.value=cause instanceof Error ? cause.message : '更新迁移预览失败' }
  finally { busy.value=false }
}
watch(() => props.refreshKey,load)
onMounted(load)
</script>

<template>
  <section class="ai-diagnostics" aria-label="模型生效诊断" :aria-busy="loading || busy">
    <header><h3>模型生效诊断</h3><div class="actions">
      <button type="button" class="btn btn-ghost" :disabled="loading || busy || !diagnosis?.effective" @click="testGeneration">{{ busy ? '处理中...' : '验证已保存模型生成' }}</button>
      <button type="button" class="btn btn-ghost icon-button" title="刷新模型诊断" aria-label="刷新模型诊断" :disabled="loading || busy" @click="load"><RefreshCw :size="18" /></button>
    </div></header>
    <p v-if="error" class="error-note" role="alert">{{ error }}</p><p v-if="notice" class="success" role="status">{{ notice }}</p>
    <p v-if="loading" role="status">正在核对配置来源...</p>
    <template v-else-if="diagnosis">
      <dl><div><dt>平台配置记录</dt><dd>{{ diagnosis.platform.configured ? '完整' : '缺失或不完整' }}</dd></div>
        <div><dt>当前企业读取来源</dt><dd>{{ diagnosis.source ? sources[diagnosis.source] : '未选择企业' }}</dd></div>
        <div><dt>配置解析与密钥读取</dt><dd :class="diagnosis.errorCode ? 'error-note' : ''">{{ diagnosis.effective ? '通过' : describe(diagnosis.errorCode) || '未验证' }}</dd></div>
        <div><dt>真实生成</dt><dd :class="probe && !probe.ok ? 'error-note' : ''">{{ probe ? (probe.ok ? `通过 · ${probe.model} · ${probe.latencyMs} 毫秒` : describe(probe.code)) : '未验证' }}</dd></div>
      </dl>
      <template v-if="!diagnosis.platform.configured && diagnosis.candidates.length">
        <h4>历史平台配置</h4><div class="source-list">
          <div v-for="item in diagnosis.candidates" :key="item.sourceOrganizationId" class="source-row">
            <div><strong>{{ item.sourceName }}</strong><p>{{ item.model }} · {{ item.baseUrlHost }}</p><small>影响当前已授权的 {{ item.affectedOrganizationCount }} 个企业<span v-if="item.errorCode"> · {{ describe(item.errorCode) }}</span></small></div>
            <button class="btn btn-ghost" type="button" :disabled="busy" @click="selected=item; confirmed=false; destination=item.baseUrlHost">核对迁移</button>
          </div>
        </div>
      </template>
      <form v-if="selected" class="migration-confirm" @submit.prevent="migrate">
        <strong>将「{{ selected.sourceName }}」的历史平台配置迁入平台统一配置</strong>
        <p>影响当前已授权的 {{ selected.affectedOrganizationCount }} 个企业；不新增授权，不删除原配置。提交时会先进行一次真实模型调用，可能产生服务商费用。</p>
        <label for="migration-base-url">迁入接口地址</label><input id="migration-base-url" v-model="destination" type="url" :disabled="busy" @input="confirmed=false; selected={...selected,canMigrate:false}" />
        <button type="button" class="btn btn-ghost" :disabled="busy || !destination.trim()" @click="updatePreview">更新迁移预览</button>
        <p v-if="selected.errorCode" class="error-note">{{ describe(selected.errorCode) }}</p>
        <label><input v-model="confirmed" type="checkbox" :disabled="busy" />已确认配置归属及影响范围</label>
        <div class="actions"><button type="button" class="btn btn-ghost" :disabled="busy" @click="selected=null">取消</button><button class="btn btn-primary" type="submit" :disabled="!confirmed || busy || !selected.canMigrate">{{ busy ? '校验并迁移中...' : '验证并迁移配置' }}</button></div>
      </form>
    </template>
  </section>
</template>

<style scoped>
.ai-diagnostics{margin-top:24px;padding-top:20px;border-top:1px solid #d9dee5;min-width:0}.ai-diagnostics header,.source-row{display:flex;align-items:center;justify-content:space-between;gap:16px}.ai-diagnostics h3{font-size:16px;margin:0}.ai-diagnostics h4{font-size:14px;margin:20px 0 8px}.actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}.icon-button{width:36px;height:36px;padding:0;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}dl{margin:16px 0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}dt{font-size:12px;color:#68727e}dd{margin:6px 0 0;overflow-wrap:anywhere;font-size:14px}.source-row{padding:12px 0;border-bottom:1px solid #e6e9ed}.source-row>div{min-width:0;overflow-wrap:anywhere}.source-row p{margin:6px 0;font-size:13px}.source-row small{color:#68727e}.source-row button{flex-shrink:0}.migration-confirm{margin-top:16px;padding:16px;border-left:3px solid #b88718;background:#fff9e9;display:grid;gap:12px;font-size:14px}.migration-confirm p{margin:0;line-height:1.7}.migration-confirm label{display:flex;gap:8px;align-items:flex-start}.success{color:#146d60}.error-note{color:#ad2838}@media(max-width:600px){.ai-diagnostics header{align-items:flex-start;flex-direction:column}dl{grid-template-columns:minmax(0,1fr)}.source-row{align-items:flex-start;flex-direction:column}.source-row button{align-self:flex-end}}
</style>
