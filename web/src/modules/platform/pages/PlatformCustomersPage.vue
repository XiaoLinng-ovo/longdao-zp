<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import EnterpriseEntitlements from '../components/EnterpriseEntitlements.vue'
import { authSession, refreshAuthSession } from '../../auth/session'
import type { ServiceStatus } from '../../auth/api'
import { listCustomers, updateCustomer, listPlatformAudit, type PlatformCustomer, type PlatformAudit } from '../api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
const entitlementCustomer = ref<PlatformCustomer | null>(null)
const statusPanel = ref<HTMLElement | null>(null), entitlementPanel = ref<HTMLElement | null>(null)
let panelNavigation = 0
async function locatePanel(panel: 'status' | 'entitlements') {
  const navigation = ++panelNavigation
  // Conditional panels must finish rendering before locating them. Only the latest click wins.
  await nextTick()
  if (navigation !== panelNavigation) return
  const target = panel === 'status' ? statusPanel.value : entitlementPanel.value
  if (!target) return
  target.focus({ preventScroll: true })
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
}
function realignEntitlements(organizationId: string) {
  // The async content changes panel height. Do not steal focus if the user has moved on.
  if (entitlementCustomer.value?.id === organizationId && document.activeElement === entitlementPanel.value) {
    void locatePanel('entitlements')
  }
}
function openEntitlements(customer: PlatformCustomer) {
  entitlementCustomer.value = customer
  void locatePanel('entitlements')
}
const customers = ref<PlatformCustomer[]>([]), audits = ref<PlatformAudit[]>([])
const search = ref(''), filter = ref(''), page = ref(1), total = ref(0)
const loading = ref(false), saving = ref(false), auditLoading = ref(false)
const error = ref(''), notice = ref(''), auditError = ref('')
const formAlert = ref('')
const reasonInput = ref<HTMLTextAreaElement | null>(null), confirmationInput = ref<HTMLInputElement | null>(null), deadlineInput = ref<HTMLInputElement | null>(null)
function rejectSave(message: string, field: HTMLElement | null) {
  error.value = message; formAlert.value = message
  field?.focus()
}
const editing = ref<PlatformCustomer | null>(null)
const draftStatus = ref<ServiceStatus>('enabled'), deadline = ref(''), reason = ref(''), confirmed = ref(false)
const canWrite = computed(() => authSession.user?.platformRole === 'admin')
const labels: Record<ServiceStatus, string> = { enabled: '已启用', trial: '试用中', suspended: '已暂停' }
const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN') : '—'
function statusLabel(customer: PlatformCustomer) {
  if (customer.status === 'archived') return '已归档'
  if (customer.serviceStatus === 'trial' && !customer.serviceAvailable) return '试用已到期'
  return labels[customer.serviceStatus]
}
async function load(reset = false) {
  if (loading.value) return
  if (reset) page.value = 1
  loading.value = true; error.value = ''; formAlert.value = ''; editing.value = null; entitlementCustomer.value = null
  try { const result = await listCustomers(search.value.trim(), filter.value, page.value); customers.value = result.items; total.value = result.total }
  catch (cause) { customers.value = []; error.value = describeApiFailure(cause, '读取企业客户失败').message }
  finally { loading.value = false }
}
function edit(customer: PlatformCustomer) {
  editing.value = customer; draftStatus.value = customer.serviceStatus; reason.value = ''; confirmed.value = false; error.value = ''; formAlert.value = ''; notice.value = ''
  const date = new Date(customer.trialEndsAt || Date.now() + 14 * 86400000)
  deadline.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  void locatePanel('status')
}
async function save() {
  const customer = editing.value
  if (!customer || saving.value || !canWrite.value) return
  error.value = ''; notice.value = ''; formAlert.value = ''
  if (reason.value.trim().length < 2 || reason.value.trim().length > 500) { rejectSave('请填写 2～500 字的操作原因', reasonInput.value); return }
  if (draftStatus.value === 'suspended' && !confirmed.value) { rejectSave('请先确认暂停对成员和后台 AI 任务的影响', confirmationInput.value); return }
  const trial = draftStatus.value === 'trial' ? new Date(deadline.value).getTime() : null
  if (trial !== null && (!Number.isFinite(trial) || trial <= Date.now())) { rejectSave('请选择未来的试用到期时间（本地时间）', deadlineInput.value); return }
  saving.value = true
  try {
    await updateCustomer(customer, draftStatus.value, trial === null ? null : new Date(trial).toISOString(), reason.value.trim())
    editing.value = null; notice.value = `${customer.name} 的服务状态已更新并记录审计`
    await refreshAuthSession(); await load(); if (audits.value.length) await loadAudit()
  } catch (cause) { error.value = describeApiFailure(cause, '保存失败，请刷新后重试').message }
  finally { saving.value = false }
}
async function loadAudit() {
  if (auditLoading.value) return
  auditLoading.value = true; auditError.value = ''
  try { audits.value = await listPlatformAudit() }
  catch (cause) { auditError.value = describeApiFailure(cause, '读取平台审计失败').message }
  finally { auditLoading.value = false }
}
async function turn(delta: number) { if (loading.value || saving.value) return; page.value += delta; await load() }
onMounted(() => load())
</script>
<template>
  <main class="platform-page">
    <Teleport to="body">
      <div v-if="formAlert" class="save-validation-alert" role="alert" aria-atomic="true">
        <span class="alert-icon" aria-hidden="true">!</span>
        <div><strong>暂时无法保存</strong><p>{{ formAlert }}</p></div>
        <button type="button" class="alert-close" aria-label="关闭保存提醒" @click="formAlert = ''">×</button>
      </div>
    </Teleport>
    <header class="platform-hero">
      <div><small>SMART RECRUIT · PLATFORM OPERATIONS</small><h1>企业客户管理</h1><p>统一管理企业服务状态，客户招聘数据仍留在各自工作空间。</p></div>
      <span class="identity">{{ canWrite ? '平台管理员' : '平台只读运营' }}</span>
    </header>
    <section class="boundary-note"><b>独立的平台运营身份</b><span>企业所有者、企业管理员不等于平台管理员。本页不提供客户简历、面试内容、模型密钥或 Skill。试用状态不代表已接入付费套餐。</span></section>
    <p v-if="error && !formAlert" class="message error" role="alert">{{ error }}</p><p v-if="notice" class="message success" role="status">{{ notice }}</p>
    <section class="panel">
      <form class="filters" @submit.prevent="load(true)">
        <label>企业名称<input v-model="search" placeholder="搜索企业客户" maxlength="120" :disabled="saving" /></label>
        <label>服务状态<select v-model="filter" :disabled="saving"><option value="">全部状态</option><option value="enabled">已启用</option><option value="trial">试用（含到期）</option><option value="suspended">已暂停</option></select></label>
        <button type="submit" :disabled="loading || saving">{{ loading ? '读取中…' : '查询 / 刷新' }}</button><span class="total">共 {{ total }} 家企业</span>
      </form>
      <div class="table-scroll"><table><thead><tr><th>企业客户</th><th>类型</th><th>服务状态</th><th>试用到期</th><th>成员数</th><th>创建时间</th><th>操作</th></tr></thead><tbody>
        <tr v-for="customer in customers" :key="customer.id"><td><b>{{ customer.name }}</b><small class="customer-id">{{ customer.id }}</small></td><td>{{ customer.kind === 'production' ? '正式企业' : '测试企业' }}</td><td><span class="badge" :class="{ unavailable: !customer.serviceAvailable }">{{ statusLabel(customer) }}</span></td><td>{{ time(customer.trialEndsAt) }}</td><td>{{ customer.memberCount }}</td><td>{{ time(customer.createdAt) }}</td><td><button v-if="canWrite" class="secondary" :disabled="customer.status === 'archived' || saving" @click="edit(customer)">管理状态</button><button class="secondary" type="button" @click="openEntitlements(customer)">套餐权益</button></td></tr>
        <tr v-if="!customers.length"><td colspan="7" class="empty">{{ loading ? '正在加载企业客户…' : error ? '读取失败，请重试' : '没有符合条件的企业客户' }}</td></tr>
      </tbody></table></div>
      <footer class="pagination"><span>第 {{ page }} / {{ Math.max(1, Math.ceil(total / 20)) }} 页</span><button class="secondary" :disabled="page <= 1 || loading || saving" @click="turn(-1)">上一页</button><button class="secondary" :disabled="page * 20 >= total || loading || saving" @click="turn(1)">下一页</button></footer>
    </section>
    <section v-if="editing && canWrite" ref="statusPanel" class="panel editor module-target" tabindex="-1" aria-label="客户服务状态编辑">
      <h2>管理服务 · {{ editing.name }}</h2><p>暂停或试用到期后，成员不能进入该企业，新后台 AI 任务不再领取；不会删除企业数据。已发送的外部模型调用无法立即撤回。</p>
      <form novalidate @submit.prevent="save">
        <div class="editor-fields"><label>目标状态<select v-model="draftStatus" :disabled="saving"><option value="enabled">启用</option><option value="trial">试用</option><option value="suspended">暂停</option></select></label><label v-if="draftStatus === 'trial'">试用到期（本地时间）<input ref="deadlineInput" v-model="deadline" type="datetime-local" :disabled="saving" /></label></div>
        <label>操作原因（必填，记录到平台审计）<textarea ref="reasonInput" v-model="reason" rows="3" maxlength="500" placeholder="例如：客户申请延长测试期限" :disabled="saving" /></label>
        <label v-if="draftStatus === 'suspended'" class="confirmation"><input ref="confirmationInput" v-model="confirmed" type="checkbox" :disabled="saving" />我已确认暂停会阻止该企业成员使用招聘业务</label>
        <div class="actions"><button type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存服务状态' }}</button><button class="secondary" type="button" :disabled="saving" @click="editing = null; formAlert = ''">取消</button><small>版本 {{ editing.serviceVersion }} · 并发修改会要求刷新，不覆盖他人操作</small></div>
      </form>
    </section>
    <section v-if="entitlementCustomer" ref="entitlementPanel" class="module-target" tabindex="-1" aria-label="客户套餐权益">
      <EnterpriseEntitlements :key="entitlementCustomer.id" :organization-id="entitlementCustomer.id" :name="entitlementCustomer.name" platform :can-write="canWrite" @ready="realignEntitlements" />
    </section>
    <section class="panel audits"><header><div><h2>平台操作审计</h2><p>最近 100 条平台操作记录，与企业招聘业务审计分离。</p></div><button class="secondary" :disabled="auditLoading" @click="loadAudit">{{ auditLoading ? '读取中…' : '查看 / 刷新审计' }}</button></header><p v-if="auditError" class="message error" role="alert">{{ auditError }}</p><ul v-if="audits.length"><li v-for="audit in audits" :key="audit.id"><b>{{ audit.organizationName || '平台授权操作' }}</b><span>{{ audit.action }} · {{ time(audit.createdAt) }}</span><p>{{ audit.metadata.reason || '—' }}</p></li></ul></section>
  </main>
</template>
<style scoped>
.module-target{scroll-margin-top:24px}.module-target:focus{outline:none}.module-target:focus-visible{outline:2px solid #79b8b6;outline-offset:4px;border-radius:18px}
.save-validation-alert{position:fixed;top:24px;right:24px;z-index:1000;display:flex;align-items:flex-start;gap:12px;box-sizing:border-box;width:min(380px,calc(100vw - 32px));padding:16px;border:1px solid #f3b5b5;border-left:4px solid #dc3545;border-radius:12px;background:#fff1f2;color:#a51d2d;box-shadow:0 8px 28px #a51d2d22}.alert-icon{display:grid;place-items:center;flex-shrink:0;width:22px;height:22px;border-radius:50%;background:#dc3545;color:white;font-weight:700}.save-validation-alert>div{flex:1;min-width:0}.save-validation-alert strong{font-size:14px}.save-validation-alert p{margin:5px 0 0;font-size:13px;line-height:1.6}.alert-close{flex-shrink:0;padding:0 4px;border:0;background:transparent;color:#a51d2d;font-size:22px;line-height:22px;cursor:pointer}.alert-close:focus-visible{outline:2px solid #dc3545;outline-offset:2px}@media(max-width:600px){.save-validation-alert{top:16px;right:16px}}

.platform-page{display:grid;gap:18px;color:#31576a}.platform-hero{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:28px 30px;border:1px solid #d5eae8;border-radius:22px;background:linear-gradient(125deg,#eaf8f3,#edf4ff)}.platform-hero small{font-size:10px;letter-spacing:2px;color:#649f9a}.platform-hero h1{margin:9px 0;font-size:26px}.platform-hero p,.editor p,.audits p{color:#718d9e;font-size:13px;line-height:1.8;margin:6px 0}.identity,.badge{display:inline-block;white-space:nowrap;padding:6px 10px;border-radius:99px;background:#ddf3e9;color:#3a8572;font-size:12px}.identity{background:#fff9;border:1px solid #c8e4dd}.boundary-note{display:grid;gap:7px;border-radius:15px;padding:17px 22px;background:#f0f6fc;color:#5e819c;font-size:12px;line-height:1.8}.panel{background:#ffffffdc;border:1px solid #dfebef;border-radius:18px;overflow:hidden;box-shadow:0 6px 22px #31576a06}.filters{display:flex;gap:14px;align-items:end;padding:20px;flex-wrap:wrap}.filters label,.editor label{display:grid;gap:8px;font-size:12px}.filters label:first-child{flex:1;min-width:180px}input,select,textarea{font:inherit;border:1px solid #d5e4ea;border-radius:9px;padding:10px 12px;background:#f8fcfe;color:#31576a}textarea{resize:vertical}input:focus,select:focus,textarea:focus{outline:2px solid #98c7d6;outline-offset:1px}button{font:inherit;font-size:12px;border:1px solid #79b8b6;border-radius:9px;padding:10px 13px;background:#459d98;color:white;cursor:pointer}button.secondary{background:#f7fbff;color:#517e96;border-color:#d7e5ee}button:disabled{opacity:.5;cursor:not-allowed}.total{font-size:12px;padding:10px 0;color:#849aa8}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;background:#f4f9fc;color:#8198a5;padding:14px 18px;white-space:nowrap}td{padding:17px 18px;border-top:1px solid #edf3f6;white-space:nowrap}.customer-id{display:block;margin-top:7px;color:#9aabb6;font-size:10px}.badge.unavailable{background:#fff0e5;color:#b78259}.empty{text-align:center;padding:36px}.pagination{display:flex;gap:12px;align-items:center;justify-content:flex-end;padding:15px 20px;border-top:1px solid #edf3f6;font-size:12px}.editor{padding:22px}.editor h2,.audits h2{font-size:16px;margin:0 0 8px}.editor form{display:grid;gap:18px;margin-top:20px}.editor-fields{display:flex;gap:20px;flex-wrap:wrap}.editor-fields label{min-width:200px}.editor label.confirmation{display:flex;align-items:center;color:#b07651}.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.actions small{color:#93a5b0;font-size:11px}.message{padding:13px 18px;margin:0;border-radius:12px;font-size:13px;line-height:1.7}.error{background:#fff1ef;color:#ae625a}.success{background:#eaf8ee;color:#53886a}.audits{padding:22px}.audits header{display:flex;justify-content:space-between;align-items:center;gap:12px}.audits ul{padding:0;list-style:none}.audits li{display:grid;gap:7px;border-top:1px solid #edf3f6;padding:13px 0;font-size:12px}.audits li span{color:#8ba1ad}@media(max-width:760px){.platform-hero{padding:20px;align-items:flex-start;flex-direction:column}.platform-hero h1{font-size:22px}.filters{padding:15px}.audits header{align-items:flex-start;flex-direction:column}}
</style>
