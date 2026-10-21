<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { getAiUsage, getUsageReviews, addUsageReview, type AiUsageReport, type UsageFilters, type ReviewNote, type ReviewInput, type ReviewOutcome, type UsageState, type UsageItem } from '../api/ai-usage'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { authSession } from '../../auth/session'
const report = ref<AiUsageReport | null>(null), error = ref(''), busy = ref(false), page = ref(1), notice = ref('')
const operation = ref<'' | 'job_spec' | 'jd'>(''), state = ref<'' | UsageState>(''), reviewOnly = ref(false), from = ref(''), to = ref('')
const selected = ref<UsageItem | null>(null), reviews = ref<ReviewNote[]>([]), detailBusy = ref(false), saving = ref(false), detailError = ref('')
const outcome = ref<ReviewOutcome>('awaiting_provider'), note = ref(''), pending = ref<ReviewInput | null>(null)
const detailPanel = ref<HTMLElement | null>(null)
let applied: UsageFilters = {}, version = 0, detailVersion = 0, alive = true
const scope = () => [authSession.user?.workspaceId, authSession.user?.id, authSession.sessionId].join(':')
const labels = { reserved: '处理中 / 已预占', settled: '已结算', released: '已释放（生成未完成）', uncertain: '待对账' }
const failureLabels = { upstream_rejected: '服务商拒绝请求', request_timeout: '模型请求超时', network_error: '模型连接失败', invalid_response: '模型返回内容无效', generation_failed: '生成或业务保存失败', settlement_failed: '用量结算保存失败' }
const reviewLabels = { awaiting_provider: '等待服务商证据', awaiting_result: '等待生成结果核对', evidence_recorded: '已记录核对证据' }
const date = (value: string) => new Date(value).toLocaleString('zh-CN')
const noteLength = computed(() => [...note.value.trim()].length)
function clearDetail() { detailVersion++; selected.value = null; reviews.value = []; detailError.value = ''; detailBusy.value = false; saving.value = false; pending.value = null; note.value = ''; outcome.value = 'awaiting_provider' }
async function load(target = page.value) {
 if (busy.value) return
 const token = ++version, workspace = scope()
 busy.value = true; error.value = ''; report.value = null; clearDetail()
 try { const result = await getAiUsage(target, applied); if (alive && token === version && workspace === scope()) { report.value = result; page.value = target } }
 catch (e) { if (alive && token === version && workspace === scope()) error.value = describeApiFailure(e, '读取 AI 用量失败').message }
 finally { if (alive && token === version && workspace === scope()) busy.value = false }
}
async function filter(reset = false) {
 if (busy.value || saving.value || pending.value) return
 if (reset) { operation.value = ''; state.value = ''; reviewOnly.value = false; from.value = ''; to.value = '' }
 const next: UsageFilters = {}
 if (operation.value) next.operation = operation.value
 if (state.value) next.state = state.value
 if (reviewOnly.value) next.reviewOnly = true
 for (const [key, value] of [['from', from.value], ['to', to.value]] as const) {
  if (value) { const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) { error.value = '请输入有效的筛选时间'; return }; next[key] = parsed.toISOString() }
 }
 if (next.from && next.to && next.from >= next.to) { error.value = '结束时间必须晚于开始时间'; return }
 applied = next; notice.value = ''; await load(1)
}
async function open(item: UsageItem) {
 if (saving.value || pending.value) return
 clearDetail(); selected.value = item
 const token = ++detailVersion, workspace = scope(); detailBusy.value = true
 await nextTick(); if (alive && token === detailVersion && workspace === scope()) detailPanel.value?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
 try { const result = await getUsageReviews(item.id); if (alive && token === detailVersion && workspace === scope()) reviews.value = result.items }
 catch (e) { if (alive && token === detailVersion && workspace === scope()) detailError.value = describeApiFailure(e, '读取核对记录失败').message }
 finally { if (alive && token === detailVersion && workspace === scope()) detailBusy.value = false }
}
async function save() {
 if (!selected.value || !selected.value.needsReconciliation || saving.value || detailBusy.value) return
 if (!pending.value && (noteLength.value < 2 || noteLength.value > 1000)) { detailError.value = '请填写 2–1000 字的核对说明'; return }
 pending.value ??= { key: crypto.randomUUID(), outcome: outcome.value, note: note.value.trim() }
 const token = detailVersion, workspace = scope(), item = selected.value, submission = { ...pending.value }
 saving.value = true; detailError.value = ''; notice.value = ''
 try {
  const result = await addUsageReview(item.id, submission)
  if (!alive || token !== detailVersion || workspace !== scope()) return
  reviews.value = [result.item, ...reviews.value.filter(r => r.id !== result.item.id)].slice(0, 20)
  if (!result.replayed) item.reviewCount++
  pending.value = null; note.value = ''; notice.value = '核对记录已保存，调用状态与结算次数保持不变。'
 } catch (e) {
  if (!alive || token !== detailVersion || workspace !== scope()) return
  const failure = describeApiFailure(e, '保存核对记录失败'); detailError.value = failure.message
  // A lost response may hide a committed note. Keep the same key and immutable body for retry.
  if (failure.status && failure.status >= 400 && failure.status < 500) pending.value = null
 } finally { if (alive && token === detailVersion && workspace === scope()) saving.value = false }
}
async function copy(value: string) {
 try { await navigator.clipboard.writeText(value); notice.value = '追踪编号已复制' }
 catch { notice.value = '复制失败，请选中下方编号手动复制' }
}
watch(scope, () => { version++; busy.value = false; report.value = null; applied = {}; operation.value = ''; state.value = ''; reviewOnly.value = false; from.value = ''; to.value = ''; notice.value = ''; clearDetail(); void load(1) })
onMounted(() => load())
onUnmounted(() => { alive = false; version++; detailVersion++ })
</script>
<template>
 <main class="usage-page">
  <header><div><h1>企业 AI 用量</h1><p>查看本企业的岗位说明书与 JD 生成记录，追踪异常并保存核对说明。</p></div><button :disabled="busy || saving || !!pending" @click="load()">{{ busy ? '读取中…' : '刷新用量' }}</button></header>
  <aside><strong>企业自带模型 · 不扣款</strong><p>每次成功生成计为 1 次平台用量，不是 Token 数或账单金额。模型服务商可能对失败请求收费，请以服务商账单为准。</p><p>当前仅覆盖升级后的岗位说明书和 JD 调用；本地模板、连接测试、历史调用、面试、简历分析与语音转写尚不计入。未开放平台托管模型、购买或自动续费。</p></aside>
  <form class="filters" aria-label="用量筛选" @submit.prevent="filter()">
   <label>生成类型<select v-model="operation" :disabled="busy || saving || !!pending"><option value="">全部类型</option><option value="job_spec">岗位说明书</option><option value="jd">JD</option></select></label>
   <label>调用状态<select v-model="state" :disabled="busy || saving || !!pending"><option value="">全部状态</option><option value="settled">已结算</option><option value="released">已释放</option><option value="reserved">已预占</option><option value="uncertain">结果不确定</option></select></label>
   <label>开始时间（含）<input v-model="from" type="datetime-local" :disabled="busy || saving || !!pending"></label>
   <label>结束时间（不含）<input v-model="to" type="datetime-local" :disabled="busy || saving || !!pending"></label>
   <label class="check"><input v-model="reviewOnly" type="checkbox" :disabled="busy || saving || !!pending">仅看待核对</label>
   <button type="submit" :disabled="busy || saving || !!pending">应用筛选</button><button type="button" :disabled="busy || saving || !!pending" @click="filter(true)">重置</button>
  </form>
  <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status" class="notice">{{ notice }}</p>
  <template v-if="report">
   <p class="caption">下方概览为本企业全部记录；筛选匹配 {{ report.filteredTotal }} 条。</p>
   <div class="stats"><div><span>调用记录</span><b>{{ report.summary.total }}</b></div><div><span>成功结算</span><b>{{ report.summary.settled }}</b></div><div><span>已释放</span><b>{{ report.summary.released }}</b></div><div><span>处理中</span><b>{{ report.summary.reserved }}</b></div><div><span>待对账</span><b>{{ report.summary.reconciliation }}</b></div></div>
   <p v-if="report.summary.reconciliation" class="warning" role="status">有结果不确定或超过 10 分钟的调用，请核对生成记录与模型服务商账单。不会自动再次调用，也不表示已退还服务商费用。</p>
   <div class="table-scroll"><table><thead><tr><th>生成类型 / 模型</th><th>状态 / 次数</th><th>调用诊断</th><th>时间</th><th>核对记录</th></tr></thead><tbody>
    <tr v-for="item in report.items" :key="item.id"><td>{{ item.operation === 'job_spec' ? '岗位说明书' : 'JD' }}<small>{{ item.model }}</small></td><td>{{ item.needsReconciliation ? '待对账' : labels[item.state] }}<small>成功 {{ item.settledUnits }} 次</small></td><td>{{ item.failureCategory ? failureLabels[item.failureCategory] : item.state === 'settled' ? '生成成功' : '暂无失败分类证据' }}<small>{{ item.durationMs === null ? '耗时未记录' : (item.durationMs / 1000).toFixed(2) + ' 秒' }}</small></td><td>{{ date(item.createdAt) }}</td><td><button :disabled="saving || !!pending" @click="open(item)">{{ item.needsReconciliation ? '查看 / 添加核对' : '查看追踪' }}（{{ item.reviewCount }}）</button></td></tr>
    <tr v-if="!report.items.length"><td colspan="5">暂无调用记录符合当前筛选。成功使用本企业模型生成岗位说明书或 JD 后，会在这里显示。</td></tr>
   </tbody></table></div>
   <footer><span>第 {{ page }} 页 · 匹配 {{ report.filteredTotal }} 条</span><button :disabled="busy || saving || !!pending || page <= 1" @click="load(page - 1)">上一页</button><button :disabled="busy || saving || !!pending || page * report.pageSize >= report.filteredTotal" @click="load(page + 1)">下一页</button></footer>
  </template>
  <section v-if="selected" ref="detailPanel" class="review-panel" aria-label="调用追踪与核对记录">
   <h2>调用追踪与核对记录</h2>
   <div class="trace"><span>调用编号</span><code>{{ selected.id }}</code><button @click="copy(selected.id)">复制调用编号</button></div>
   <div class="trace"><span>请求追踪</span><code>{{ selected.requestId || '历史记录未保存请求编号' }}</code><button v-if="selected.requestId" @click="copy(selected.requestId)">复制请求编号</button></div>
   <p>核对记录仅保存处理进度与证据说明，不会改变调用状态或结算次数，也不会再次调用模型。请勿在说明中填写密钥、简历等敏感内容。</p>
   <p v-if="detailBusy">读取核对记录中…</p><p v-if="detailError" role="alert" class="error">{{ detailError }}</p>
   <ul v-if="reviews.length" class="reviews"><li v-for="record in reviews" :key="record.id"><strong>{{ reviewLabels[record.outcome] }}</strong><small>{{ date(record.createdAt) }} · 记录人 {{ record.actorId }}</small><p>{{ record.note }}</p></li></ul>
   <p v-else-if="!detailBusy && !detailError">尚未添加人工核对记录。最多展示最近 20 条。</p>
   <form v-if="selected.needsReconciliation" class="review-form" aria-label="添加核对记录" @submit.prevent="save">
    <label>处理进度<select v-model="outcome" :disabled="saving || !!pending || detailBusy"><option value="awaiting_provider">等待服务商证据</option><option value="awaiting_result">等待生成结果核对</option><option value="evidence_recorded">已记录核对证据</option></select></label>
    <label>核对说明<textarea v-model="note" rows="4" :disabled="saving || !!pending || detailBusy" placeholder="例如：已核查岗位版本，正在等待模型服务商账单确认。" /></label><small>{{ noteLength }} / 1000 字</small>
    <p v-if="pending && !saving" class="warning">上次提交结果尚未确认。请用下方按钮重试同一条记录，避免重复保存。</p>
    <button :disabled="saving || detailBusy || (!pending && (noteLength < 2 || noteLength > 1000))" type="submit">{{ saving ? '保存中…' : pending ? '重试保存同一记录' : '保存核对记录' }}</button>
   </form>
  </section>
 </main>
</template>
<style scoped>
.usage-page{display:grid;gap:20px;color:#31576a}header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:24px;border-radius:20px;background:linear-gradient(115deg,#eaf8f3,#edf4ff)}h1{margin:0;font-size:24px}h2{font-size:18px}p{font-size:13px;line-height:1.8;color:#688699}aside,.review-panel{padding:20px;border:1px solid #d4e9e5;border-radius:16px;background:#f3faf7}.stats{display:flex;flex-wrap:wrap;gap:14px}.stats>div{flex:1;min-width:130px;display:grid;gap:12px;padding:20px;background:#f2f7ff;border-radius:14px}.stats span{font-size:12px}.stats b{font-size:24px}.table-scroll{overflow:auto;border:1px solid #dcebe8;border-radius:14px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:16px;text-align:left;border-bottom:1px solid #edf3f6}th{background:#f3f9fc}button{padding:10px 14px;border:1px solid #88bbb1;border-radius:9px;background:#e0f2eb;color:#366f65;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}footer{display:flex;justify-content:flex-end;gap:12px;align-items:center;font-size:12px}.error,.warning,.notice{padding:15px;border-radius:12px}.error{background:#fff0f0;color:#a43b42}.warning{background:#fff4e5;color:#916532}.notice{background:#e6f5ee;color:#396e5e}.filters{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;padding:18px;border-radius:14px;background:#f2f8fc}label{display:grid;gap:7px;font-size:12px}.check{display:flex;align-items:center;min-height:38px}input,select,textarea{padding:10px;border:1px solid #c3dcd5;border-radius:8px;background:#ffffffb3;color:#31576a;font:inherit}small{display:block;margin-top:6px;color:#688699;font-size:12px}.caption{margin:0}.review-form{display:grid;gap:12px}.review-form button{justify-self:start}.trace{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:12px 0;font-size:12px}code{overflow-wrap:anywhere}.reviews{padding:0;list-style:none}.reviews li{padding:14px;border-bottom:1px solid #d4e9e5}.reviews p{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:700px){header{align-items:flex-start;flex-direction:column}.filters>label{width:100%}footer{flex-wrap:wrap}}
</style>
