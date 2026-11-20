<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { AlertTriangle, CircleCheck, CircleX, Clock3, Download, LoaderCircle, RefreshCw } from '@lucide/vue';
import { getPaymentBills, reconcilePaymentBill, formatPayment, type PaymentChannel, type PaymentBillReport } from '../api/payments';
import { describeApiFailure } from '../../../shared/utils/errorMessage';

const props = defineProps<{ providers: PaymentChannel[] }>();
const channels = computed(() => props.providers.filter(p => p.kind === 'alipay' && p.environment !== 'sandbox'));
const reports = ref<PaymentBillReport[]>([]);
const providerId = ref('');
const billDate = ref(new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10));
const reason = ref('');
const busy = ref(false);
const loading = ref(false);
const loaded = ref(false);
const error = ref('');
const filter = ref<'all' | 'attention' | 'succeeded'>('all');
const labels: Record<PaymentBillReport['status'], string> = {
  running: '正在对账', succeeded: '账单一致', differences: '存在差异', not_ready: '账单未就绪', failed: '对账失败',
};
const statusIcons = { running: LoaderCircle, succeeded: CircleCheck, differences: AlertTriangle, not_ready: Clock3, failed: CircleX };
const types: Record<string, string> = {
  bill_only: '账单有记录，本地无订单', amount_mismatch: '金额不符', transaction_mismatch: '交易号不符',
  payment_not_recorded: '本地未确认收款', refund_not_recorded: '本地未确认退款',
  local_payment_only: '本地收款未见账单记录', local_refund_only: '本地退款未见账单记录',
};
const needsAttention = (r: PaymentBillReport) => ['failed', 'differences', 'not_ready'].includes(r.status);
const summary = computed(() => ({
  attention: reports.value.filter(needsAttention).length,
  differences: reports.value.filter(r => r.status === 'differences').length,
  succeeded: reports.value.filter(r => r.status === 'succeeded').length,
}));
const visibleReports = computed(() => reports.value
  .filter(r => filter.value === 'all' || (filter.value === 'attention' ? needsAttention(r) : r.status === 'succeeded'))
  .sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || b.billDate.localeCompare(a.billDate) || a.providerName.localeCompare(b.providerName)));
const dateTime = (value: string | null) => {
  if (!value || Number.isNaN(Date.parse(value))) return '未安排';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
};

async function load() {
  if (loading.value || busy.value) return;
  loading.value = true;
  error.value = '';
  try {
    reports.value = await getPaymentBills();
    loaded.value = true;
  } catch (e) {
    error.value = describeApiFailure(e, '读取对账报告失败').message;
  } finally {
    loading.value = false;
  }
}
async function run() {
  if (busy.value || loading.value || !providerId.value || !billDate.value || reason.value.trim().length < 2) return;
  busy.value = true;
  error.value = '';
  try {
    reports.value = await reconcilePaymentBill({ providerId: providerId.value, billDate: billDate.value, reason: reason.value.trim() });
    loaded.value = true;
    filter.value = 'all';
  } catch (e) {
    error.value = describeApiFailure(e, '对账失败').message;
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>

<template>
  <section class="bill-panel" aria-labelledby="bill-heading" :aria-busy="loading || busy">
    <div class="bill-heading">
      <div>
        <h2 id="bill-heading">支付宝官方账单对账</h2>
        <p class="schedule">自动对账：北京时间每日 10:00 · 补查最近 7 天</p>
      </div>
      <button type="button" class="bill-button secondary" :disabled="busy || loading" @click="load">
        <RefreshCw :size="16" :class="{ spinning: loading }" aria-hidden="true" />{{ loading ? '正在读取' : '刷新报告' }}
      </button>
    </div>

    <dl v-if="loaded" class="bill-summary" aria-label="对账概况">
      <div><dt>报告总数</dt><dd>{{ reports.length }}<span>份</span></dd></div>
      <div class="attention-metric"><dt>异常 / 待重试</dt><dd>{{ summary.attention }}<span>份</span></dd></div>
      <div class="difference-metric"><dt>存在差异</dt><dd>{{ summary.differences }}<span>份</span></dd></div>
      <div class="success-metric"><dt>账单一致</dt><dd>{{ summary.succeeded }}<span>份</span></dd></div>
    </dl>

    <form class="bill-form" @submit.prevent="run">
      <label>支付宝正式渠道<select v-model="providerId" required :disabled="busy || loading"><option value="" disabled>请选择渠道</option><option v-for="p in channels" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
      <label>账单日期（北京时间）<input v-model="billDate" required type="date" :disabled="busy || loading" /></label>
      <label class="reason-field">核对原因<input v-model="reason" required minlength="2" maxlength="500" :disabled="busy || loading" /></label>
      <button type="submit" class="bill-button primary" :disabled="busy || loading || !providerId || reason.trim().length < 2">
        <LoaderCircle v-if="busy" :size="16" class="spinning" aria-hidden="true" /><Download v-else :size="16" aria-hidden="true" />{{ busy ? '正在下载与核对' : '下载账单并对账' }}
      </button>
    </form>
    <p v-if="!channels.length" class="channel-empty">暂无支付宝正式渠道</p>
    <p v-if="error" class="bill-error" role="alert"><CircleX :size="18" aria-hidden="true" /><span>{{ error }}</span></p>

    <div v-if="loaded && reports.length" class="report-toolbar">
      <div class="report-filters" role="group" aria-label="筛选对账状态">
        <button type="button" :aria-pressed="filter === 'all'" @click="filter = 'all'">全部 <span>{{ reports.length }}</span></button>
        <button type="button" :aria-pressed="filter === 'attention'" @click="filter = 'attention'">异常 / 待重试 <span>{{ summary.attention }}</span></button>
        <button type="button" :aria-pressed="filter === 'succeeded'" @click="filter = 'succeeded'">账单一致 <span>{{ summary.succeeded }}</span></button>
      </div>
      <span class="report-count" role="status">{{ visibleReports.length }} 份报告 · 异常优先</span>
    </div>
    <p v-if="loading && !loaded" class="empty-state" role="status">正在读取对账报告…</p>
    <p v-else-if="loaded && !reports.length" class="empty-state">尚无对账报告</p>
    <p v-else-if="loaded && !visibleReports.length" class="empty-state">此状态下暂无对账报告</p>

    <div class="report-list">
      <article v-for="r in visibleReports" :key="r.id" class="bill-report" :data-status="r.status" :aria-label="`${r.billDate} ${r.providerName} ${labels[r.status]}`">
        <div class="report-heading">
          <div class="report-title"><h3>{{ r.billDate }}</h3><span class="report-provider">{{ r.providerName }}</span><span class="environment">{{ r.environment === 'sandbox' ? '沙箱测试' : '正式环境' }}</span></div>
          <span class="report-status"><component :is="statusIcons[r.status]" :size="16" :class="{ spinning: r.status === 'running' }" aria-hidden="true" />{{ labels[r.status] }}</span>
        </div>
        <dl class="report-metrics">
          <div><dt>账单笔数</dt><dd>{{ r.entryCount }} <span>笔</span></dd></div>
          <div :class="{ 'has-differences': r.differenceCount > 0 }"><dt>差异笔数</dt><dd>{{ ['succeeded', 'differences'].includes(r.status) ? r.differenceCount : '待核对' }} <span v-if="['succeeded', 'differences'].includes(r.status)">笔</span></dd></div>
          <div><dt>核对尝试</dt><dd>{{ r.attempts }} <span>次</span></dd></div>
        </dl>
        <div v-if="r.status === 'failed' || r.status === 'not_ready' || r.errorCode" class="report-issue">
          <component :is="r.status === 'not_ready' ? Clock3 : AlertTriangle" :size="18" aria-hidden="true" />
          <div>
            <strong>{{ r.status === 'not_ready' ? '账单尚未生成或当日无交易' : r.errorCode === 'PAYMENT_UPSTREAM_UNCERTAIN' ? '支付渠道返回结果不确定，本次对账未完成' : '本次对账未完成' }}</strong>
            <p v-if="r.errorCode">错误码：<code>{{ r.errorCode }}</code></p>
          </div>
        </div>
        <details v-if="r.differences.length" class="report-details" :open="r.status === 'differences'">
          <summary>差异明细 · {{ r.differenceCount }} 笔<span v-if="r.differenceCount > r.differences.length">（显示前 {{ r.differences.length }} 条）</span></summary>
          <div class="bill-scroll" role="region" aria-label="对账差异明细" tabindex="0">
            <table><thead><tr><th>问题</th><th>商户订单号</th><th>退款请求号</th><th>本地金额</th><th>账单金额</th></tr></thead>
              <tbody><tr v-for="(d, i) in r.differences" :key="i"><td class="difference-type">{{ types[d.type] ?? d.type }}</td><td>{{ d.outTradeNo }}</td><td>{{ d.refundId || '—' }}</td><td>{{ d.expectedFen == null ? '—' : formatPayment(d.expectedFen) }}</td><td>{{ d.actualFen == null ? '—' : formatPayment(d.actualFen) }}</td></tr></tbody>
            </table>
          </div>
        </details>
        <footer class="report-footer">
          <span v-if="r.status === 'failed' || r.status === 'not_ready'">待自动重试 · {{ dateTime(r.nextRetryAt) }}（北京时间）</span>
          <span v-else-if="r.status === 'running'">对账进行中</span>
          <span v-else>完成于 {{ dateTime(r.completedAt) }}（北京时间）</span>
        </footer>
      </article>
    </div>
  </section>
</template>

<style scoped>
.bill-panel { padding: 24px 0; color: #183049; }
.bill-heading, .report-heading, .report-title, .report-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.bill-heading { align-items: flex-start; }
h2 { margin: 0; font-size: 20px; line-height: 1.4; }
.schedule { margin: 8px 0 0; color: #62748a; font-size: 13px; line-height: 1.6; }
.bill-button { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; gap: 7px; min-height: 40px; padding: 9px 12px; font: inherit; font-size: 14px; border: 1px solid #c7d6e2; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.bill-button svg { margin: 0; flex-shrink: 0; }
.secondary { background: #fff; color: #27618f; }
.primary { background: #176bb3; border-color: #176bb3; color: #fff; }
button:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible, summary:focus-visible, .bill-scroll:focus-visible { outline: 2px solid #176bb3; outline-offset: 3px; }
.bill-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 22px 0; padding: 18px 0; border-block: 1px solid #d6e1e9; }
.bill-summary > div { padding: 0 20px; border-left: 1px solid #d6e1e9; }
.bill-summary > div:first-child { padding-left: 0; border-left: 0; }
dt { color: #62748a; font-size: 13px; }
dd { margin: 7px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; }
.bill-summary dd { font-size: 26px; line-height: 1.2; }
dd span { margin-left: 3px; font-size: 12px; font-weight: 400; color: #62748a; }
.attention-metric dd { color: #b43333; }
.difference-metric dd { color: #a15b09; }
.success-metric dd { color: #22724d; }
.bill-form { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(180px, .85fr) minmax(180px, 1.2fr) auto; gap: 14px; align-items: end; margin: 22px 0; }
.bill-form label { display: grid; min-width: 0; gap: 8px; font-size: 13px; font-weight: 500; }
.bill-form input, .bill-form select { box-sizing: border-box; width: 100%; min-width: 0; min-height: 40px; padding: 9px 10px; border: 1px solid #c7d6e2; border-radius: 6px; background: #fff; color: #183049; font: inherit; }
.bill-error { display: flex; align-items: flex-start; gap: 10px; border: 1px solid #efb8b8; background: #fff1f1; color: #a42e2e; border-radius: 6px; padding: 13px 14px; line-height: 1.6; overflow-wrap: anywhere; }
.bill-error svg { flex-shrink: 0; margin-top: 3px; }
.channel-empty, .empty-state { padding: 16px 0; color: #62748a; font-size: 14px; }
.report-toolbar { flex-wrap: wrap; margin: 26px 0 14px; }
.report-filters { display: flex; flex-wrap: wrap; gap: 3px; border: 1px solid #cbd9e4; padding: 3px; border-radius: 6px; background: #edf2f6; }
.report-filters button { border: 0; border-radius: 3px; padding: 8px 12px; color: #526477; background: transparent; font: inherit; font-size: 13px; cursor: pointer; }
.report-filters button[aria-pressed="true"] { color: #183049; background: #fff; box-shadow: 0 1px 3px #1830491a; font-weight: 600; }
.report-filters button span { margin-left: 5px; font-variant-numeric: tabular-nums; }
.report-count { color: #62748a; font-size: 12px; }
.report-list { display: grid; gap: 14px; }
.bill-report { min-width: 0; padding: 18px 20px 0; border: 1px solid #cbd9e4; border-left: 4px solid #6b8aa5; border-radius: 6px; background: #fff; }
.bill-report[data-status="failed"] { border-left-color: #c84444; }
.bill-report[data-status="differences"], .bill-report[data-status="not_ready"] { border-left-color: #c58a20; }
.bill-report[data-status="succeeded"] { border-left-color: #318565; }
.report-title { justify-content: flex-start; flex-wrap: wrap; gap: 8px 12px; min-width: 0; }
h3 { margin: 0; font-size: 16px; font-variant-numeric: tabular-nums; }
.report-provider { font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }
.environment { color: #6a7b8c; font-size: 12px; }
.report-status { display: inline-flex; align-items: center; flex-shrink: 0; gap: 6px; padding: 5px 8px; border-radius: 4px; background: #edf3fa; color: #27618f; font-size: 13px; font-weight: 600; }
[data-status="failed"] .report-status { background: #fff0f0; color: #b43333; }
[data-status="differences"] .report-status, [data-status="not_ready"] .report-status { background: #fff5e2; color: #8e5c10; }
[data-status="succeeded"] .report-status { background: #edf8f1; color: #22724d; }
.report-metrics { display: flex; flex-wrap: wrap; gap: 20px 48px; margin: 18px 0; }
.report-metrics dd { font-size: 16px; }
.has-differences dd { color: #b43333; }
.report-issue { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 16px; padding: 12px 14px; border-left: 2px solid #e5a5a5; background: #fff5f5; color: #9d3535; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.report-issue svg { flex-shrink: 0; margin-top: 2px; }
.report-issue strong { font-weight: 500; }
.report-issue p { margin: 4px 0 0; color: inherit; }
.report-issue code { font-size: 12px; overflow-wrap: anywhere; }
[data-status="not_ready"] .report-issue { border-left-color: #d9b96e; background: #fffaee; color: #875e1d; }
.report-details { border-top: 1px solid #e2e9ef; margin-top: 16px; }
.report-details summary { padding: 13px 0; cursor: pointer; font-size: 13px; color: #89550b; font-weight: 600; }
.bill-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 12px 10px; border-bottom: 1px solid #e2e9ef; text-align: left; white-space: nowrap; }
th { background: #f3f6f8; color: #526477; font-weight: 500; }
.difference-type { color: #a14425; font-weight: 500; }
.report-footer { padding: 11px 0; border-top: 1px solid #e2e9ef; color: #6a7b8c; font-size: 12px; line-height: 1.6; }
.spinning { animation: bill-spin 1s linear infinite; }
@keyframes bill-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }
@media (max-width: 1000px) { .bill-form { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) {
  .bill-heading { gap: 10px; }
  h2 { font-size: 18px; }
  .bill-heading .bill-button { font-size: 12px; padding: 8px; }
  .bill-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 0; }
  .bill-summary > div { padding: 0 14px; }
  .bill-summary > div:nth-child(3) { border-left: 0; padding-left: 0; }
  .bill-summary dd { font-size: 24px; }
  .bill-form { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .report-heading { align-items: flex-start; }
  .report-title { gap: 6px 10px; }
  .report-title h3 { flex-basis: 100%; }
  .bill-report { padding: 14px 12px 0; }
  .report-metrics { gap: 16px 24px; }
  .report-filters { width: 100%; box-sizing: border-box; }
  .report-filters button { flex: 1; padding: 8px 4px; font-size: 12px; }
}
</style>
