<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import QRCode from "qrcode";
import EnterpriseServicePanel from '../components/EnterpriseServicePanel.vue';
import { Check, CalendarDays, UsersRound, BriefcaseBusiness, Zap, RefreshCw } from "@lucide/vue";
import { authSession, refreshAuthSession } from "../../auth/session";
import {
  getCheckout,
  getPaymentOrder,
  createPaymentOrder,
  paymentOrderAction,
  paymentStatusLabel,
  formatPayment,
  paymentDurationLabel,
  type Checkout,
  type PaymentOrder,
} from "../api/payments";
import { formatBillingAmount } from '../utils/billingUnits';
import { billingResourceLabels } from '../utils/billingUnits';
import { productQuotaLines, capacityIssue, subscriptionPreview } from '../utils/paymentProducts';
import { formatBusinessDateTime } from '../../../shared/utils/date-time';
import { describeApiFailure } from "../../../shared/utils/errorMessage";
const route = useRoute(),
  router = useRouter(),
  report = ref<Checkout | null>(null),
  order = ref<PaymentOrder | null>(null);
const productId = ref(""),
  providerId = ref(""),
  method = ref<"wxpay" | "alipay">("alipay"),
  wechatMode = ref<"qrcode" | "redirect">("qrcode");
const busy = ref(false),
  loading = ref(true),
  error = ref(""),
  qr = ref(""),
  seconds = ref(0);
const now = ref(Date.now());
const tab = ref<'addon'|'subscription'>('addon');
const historyType = ref('all');
const visibleProducts = computed(()=>report.value?.products.filter(p=>(p.billingKind ?? 'subscription')===tab.value) ?? []);
const historyOrders = computed(()=>report.value?.orders.filter(o=>historyType.value==='all' || (o.billingKind ?? 'subscription')===historyType.value) ?? []);
const allowedMethods = computed(()=>(['alipay','wxpay'] as const).filter(m=>report.value?.providers.some(p=>p.kind===m || p.kind==='easypay')));
watch(allowedMethods,list=>{if(!list.includes(method.value))method.value=list[0] ?? 'alipay'});
watch(visibleProducts,list=>{if(!list.some(p=>p.id===productId.value))productId.value=list[0]?.id ?? ''});
const issue = computed(()=>product.value && report.value ? capacityIssue(product.value,report.value.organization) : '');
const forecast = computed(()=>product.value && product.value.billingKind!=='addon' && report.value ? subscriptionPreview(product.value,report.value.organization) : null);
const date = (value:string|null|undefined)=>value ? formatBusinessDateTime(value) : '—';
const pendingOrder = computed(() => {
  const pending = report.value?.pendingOrder;
  return pending && (pending.cancelRequestedAt || pending.channelClosePending || Date.parse(pending.expiresAt) > now.value ||
    (pending.method === 'alipay' && ['redirect', 'wap'].includes(pending.mode) && Boolean(pending.payURL))) ? pending : null;
});
const org = computed(() =>
  typeof route.query.workspace === "string"
    ? route.query.workspace
    : (authSession.user?.workspaceId ?? ""),
);
const providers = computed(
  () =>
    report.value?.providers.filter(
      (p) => p.kind === "easypay" || p.kind === method.value,
    ) ?? [],
);
const product = computed(() =>
  report.value?.products.find((p) => p.id === productId.value),
);
const priceUnit = (months: number | null | undefined) =>
  months === 12 ? "年" : months === 6 ? "半年" : months === 1 ? "月" : null;
const terminal = computed(
  () =>
    order.value &&
    ["fulfilled", "review", "refunded", "expired", "cancelled"].includes(
      order.value.status,
    ),
);
const paying = computed(
  () =>
    order.value &&
    ["creating", "pending", "uncertain"].includes(order.value.status),
);
const cancelling = computed(() => Boolean(paying.value && order.value?.cancelRequestedAt));
const expiryClosing = computed(() => paying.value && order.value?.method === 'alipay' &&
  ['redirect', 'wap'].includes(order.value.mode) && seconds.value === 0 && order.value.creationOutcome !== 'not_created');
const orderStatus = (value: PaymentOrder) => value.cancelRequestedAt && ["pending", "uncertain"].includes(value.status)
  ? "取消待确认" : value.status === 'cancelled' && value.channelClosePending ? '已取消（本地）'
    : value.channelClosePending ? '关单待确认'
    : value.status === 'uncertain' && value.creationOutcome === 'not_created' ? '创建失败' : value.status==='fulfilled' && value.billingKind==='addon' ? '支付成功 · 算力已到账' : paymentStatusLabel[value.status];
let retry: {
    key: string;
    input: Parameters<typeof createPaymentOrder>[1];
  } | null = null,
  timer: ReturnType<typeof setInterval> | undefined,
  tick = 0,
  generation = 0;
let loadGeneration = 0;
let refreshingCheckout = false;
const remaining = (value: string | undefined) =>
  Math.max(0, Math.ceil((Date.parse(value ?? "") - Date.now()) / 1000)) || 0;
watch(
  () => order.value?.expiresAt,
  (value) => {
    seconds.value = remaining(value);
  },
);
watch(providers, (list) => {
  if (!list.some((p) => p.id === providerId.value))
    providerId.value = list[0]?.id ?? "";
});
watch(
  () => order.value?.qrCode,
  async (value) => {
    qr.value = "";
    const stamp = ++generation;
    if (value) {
      try {
        const image = await QRCode.toDataURL(value, {
          width: 280,
          margin: 2,
          errorCorrectionLevel: "M",
        });
        if (stamp === generation) qr.value = image;
      } catch {
        if (stamp === generation) error.value = "二维码无法生成，请尝试跳转支付或联系管理员";
      }
    }
  },
);
function fail(e: unknown) {
  error.value = describeApiFailure(e, "支付服务暂时不可用").message;
}
async function load() {
  const stamp = ++loadGeneration;
  loading.value = true;
  error.value = "";
  order.value = null;
  report.value = null;
  retry = null;
  busy.value = false;
  refreshingCheckout = false;
  try {
    const workspace = org.value,
      id = route.params.id;
    const data = await getCheckout(workspace);
    const current =
      typeof id === "string" ? await getPaymentOrder(workspace, id) : null;
    if (stamp !== loadGeneration) return;
    report.value = data;
    if (!data.products.some(p=>p.billingKind==='addon')) tab.value='subscription';
    productId.value = data.products.find(p=>(p.billingKind ?? 'subscription')===tab.value)?.id ?? '';
    order.value = current;
  } catch (e) {
    if (stamp === loadGeneration) fail(e);
  } finally {
    if (stamp === loadGeneration) loading.value = false;
  }
}
async function create() {
  if (busy.value || loading.value || !productId.value || !providerId.value || !report.value?.canPurchase || pendingOrder.value || issue.value)
    return;
  busy.value = true;
  const workspace=org.value, stamp=loadGeneration;
  error.value = "";
  const input = {
    productId: productId.value,
    providerId: providerId.value,
    method: method.value,
    mode: method.value === "alipay" ? "redirect" as const : wechatMode.value,
    expectedVersion: report.value.organization.entitlementVersion,
  };
  if (!retry || JSON.stringify(retry.input) !== JSON.stringify(input))
    retry = { key: crypto.randomUUID(), input };
  try {
    const result = await createPaymentOrder(workspace, retry.input, retry.key);
    if (stamp!==loadGeneration || workspace!==org.value) return;
    order.value = result;
    retry = null;
    await router.push({
      name: "enterprise-payment-order",
      params: { id: order.value.id },
      query: { workspace: org.value },
    });
  } catch (e) {
    if (stamp!==loadGeneration || workspace!==org.value) return;
    if (describeApiFailure(e).code === "PAYMENT_ORDER_ALREADY_PENDING") {
      retry = null;
      try {
        const data=await getCheckout(workspace);
        if (stamp!==loadGeneration || workspace!==org.value) return;
        report.value = data;
        const pending = report.value.pendingOrder;
        if (pending) {
          await router.push({
            name: "enterprise-payment-order",
            params: { id: pending.id },
            query: { workspace: org.value },
          });
          return;
        }
      } catch (refreshError) {
        fail(refreshError);
        return;
      }
    }
    fail(e);
  } finally {
    if (stamp === loadGeneration) busy.value = false;
  }
}
async function refreshCheckout() {
  if (refreshingCheckout || busy.value || loading.value || order.value || !report.value) return;
  refreshingCheckout = true;
  const stamp = loadGeneration;
  const previousVersion = report.value.organization.entitlementVersion;
  try {
    const data = await getCheckout(org.value);
    if (stamp !== loadGeneration) return;
    report.value = data;
    if (!visibleProducts.value.some((item) => item.id === productId.value))
      productId.value = visibleProducts.value[0]?.id ?? "";
    if (data.organization.entitlementVersion !== previousVersion)
      await refreshAuthSession();
  } catch {
    // Background refresh keeps the last result; explicit actions still report failures.
  } finally {
    if (stamp === loadGeneration) refreshingCheckout = false;
  }
}
async function action(kind: "verify" | "cancel", quiet = false) {
  if (!order.value || busy.value) return;
  if (kind === "cancel" && !window.confirm("确认关闭此付款订单？")) return;
  busy.value = true;
  if (!quiet) error.value = "";
  const workspace=org.value, stamp=loadGeneration;
  try {
    const previous = order.value.status;
    const result=await paymentOrderAction(workspace, order.value.id, kind);
    if (stamp!==loadGeneration || workspace!==org.value) return;
    order.value = result;
    if (report.value) {
      report.value.orders = report.value.orders.map((item) =>
        item.id === order.value!.id ? order.value! : item,
      );
      if (report.value.pendingOrder?.id === order.value.id)
        report.value.pendingOrder = paying.value || (order.value.channelClosePending && ['redirect', 'wap'].includes(order.value.mode)) ? order.value : null;
    }
    if (order.value.status === "fulfilled" && previous !== "fulfilled")
      await refreshAuthSession();
  } catch (e) {
    if (!quiet && stamp===loadGeneration && workspace===org.value) fail(e);
  } finally {
    if (stamp === loadGeneration) busy.value = false;
  }
}
const safePayURL = computed(() => {
  try {
    const u = new URL(order.value?.payURL ?? "");
    return u.protocol === "https:" && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
});
const countdown = computed(
  () =>
    `${Math.floor(seconds.value / 60)
      .toString()
      .padStart(2, "0")}:${(seconds.value % 60).toString().padStart(2, "0")}`,
);
watch(
  () => [route.fullPath, org.value],
  () => void load(),
);
onMounted(() => {
  void load();
  timer = setInterval(() => {
    now.value = Date.now();
    seconds.value =
      Math.max(
        0,
        Math.ceil(
          (Date.parse(order.value?.expiresAt ?? "") - Date.now()) / 1000,
        ),
      ) || 0;
    if (++tick % 15 === 0) {
      if (order.value && (!terminal.value || order.value.channelClosePending)) void action("verify", true);
      else if (!order.value) void refreshCheckout();
    }
  }, 1000);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  generation++;
  loadGeneration++;
});
</script>
<template>
  <main class="payment-page">
    <header>
      <div>
        <span class="eyebrow">企业服务</span>
        <h1>充值与订阅</h1>
        <p>
          {{ report?.organization.name ?? "企业付款中心" }} ·
          {{ report?.organization.planName ?? '企业付款中心' }}
        </p>
      </div>
      <RouterLink to="/workspaces" class="secondary">企业工作空间</RouterLink>
    </header>
    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">正在读取企业订单…</p>
    <template v-else-if="report">
      <template v-if="!order">
        <nav class="purchase-tabs" aria-label="购买类型">
          <button :class="{active:tab==='addon'}" :aria-pressed="tab==='addon'" @click="tab='addon'"><Zap :size="18" />算力充值</button>
          <button :class="{active:tab==='subscription'}" :aria-pressed="tab==='subscription'" @click="tab='subscription'"><CalendarDays :size="18" />服务订阅</button>
          <button class="refresh" title="刷新余额和商品" aria-label="刷新余额和商品" @click="load"><RefreshCw :size="18" /></button>
        </nav>
        <p v-if="report.organization.serviceAvailable===false" class="alert">企业服务已到期或暂停，已有付费余额保留。<button class="secondary" @click="tab='subscription'">开通或续费服务</button></p>
        <section v-if="tab==='addon' && report.billing" class="credit-balances" aria-label="企业共享余额">
          <div v-for="(label,key) in billingResourceLabels" :key="key"><span>{{label}}</span><strong>{{formatBillingAmount(report.billing.resources.find(r=>r.resource===key)?.available ?? 0,key)}}</strong><small>长期 {{formatBillingAmount(report.billing.resources.find(r=>r.resource===key)?.permanent ?? 0,key)}} · 预占 {{formatBillingAmount(report.billing.resources.find(r=>r.resource===key)?.reserved ?? 0,key)}}</small></div>
        </section>
        <section v-else-if="tab==='subscription'" class="subscription-current" aria-label="当前订阅"><b>{{report.organization.planName ?? '当前服务'}}</b><span>到期：{{date(report.organization.expiresAt ?? report.organization.trialEndsAt)}}</span><span>席位 {{report.organization.seatUsage}} / {{report.organization.seatLimit ?? '不限'}} · 岗位 {{report.organization.jobUsage}} / {{report.organization.jobLimit ?? '不限'}}</span></section>
      </template>
      <section v-if="!order && pendingOrder" class="pending-order" aria-label="企业待支付订单">
        <div>
          <h2>{{ pendingOrder.cancelRequestedAt ? '企业订单取消待确认' : pendingOrder.channelClosePending || Date.parse(pendingOrder.expiresAt) <= now ? '企业订单关单待确认' : pendingOrder.creationOutcome === 'not_created' ? '企业有创建失败的订单' : '企业已有待支付订单' }}</h2>
          <p>{{ pendingOrder.name }} · {{ formatPayment(pendingOrder.amountFen) }} · {{ orderStatus(pendingOrder) }}</p>
          <p class="order-number">订单号 {{ pendingOrder.outTradeNo }}</p>
        </div>
        <RouterLink class="primary" :to="{ name: 'enterprise-payment-order', params: { id: pendingOrder.id }, query: { workspace: org } }">{{ pendingOrder.cancelRequestedAt ? '查看取消进度' : pendingOrder.channelClosePending || Date.parse(pendingOrder.expiresAt) <= now ? '查看关单进度' : pendingOrder.creationOutcome === 'not_created' ? '查看并取消订单' : '继续支付已有订单' }}</RouterLink>
      </section>
      <section v-if="!order" class="purchase-layout">
        <div>
          <h2>{{tab==='addon'?'算力充值':'服务订阅'}}</h2>
          <p v-if="!visibleProducts.length" class="empty">
            暂无在售{{tab==='addon'?'充值商品':'订阅套餐'}}，请联系平台管理员。
            <RouterLink v-if="authSession.user?.isSystemAdmin === true" to="/platform/payments">配置正式套餐</RouterLink>
          </p>
          <div class="products">
            <button
              v-for="p in visibleProducts"
              :key="p.id"
              class="product"
              :class="{ selected: productId === p.id }"
              :aria-pressed="productId === p.id"
              :aria-label="p.name + '，' + formatPayment(p.amountFen) + '，' + paymentDurationLabel(p)"
              @click="productId = p.id"
            >
              <span class="product-heading"><b>{{ p.name }}</b><span class="selection-indicator"><Check v-if="productId === p.id" :size="14" aria-hidden="true" /></span></span>
              <span class="product-price"><strong>{{ formatPayment(p.amountFen) }}</strong><span v-if="p.billingKind!=='addon' && priceUnit(p.durationMonths)"> / {{ priceUnit(p.durationMonths) }}</span></span>
              <span v-if="p.allModules" class="product-features"><Check :size="16" aria-hidden="true" />全部模块功能</span>
              <span class="product-detail"><CalendarDays :size="16" aria-hidden="true" />使用期限：{{ paymentDurationLabel(p) }}</span>
              <span v-if="p.billingKind!=='addon'" class="product-detail"><UsersRound :size="16" aria-hidden="true" />{{ p.seatLimit }} 个席位</span>
              <span v-if="p.billingKind!=='addon'" class="product-detail"><BriefcaseBusiness :size="16" aria-hidden="true" />{{ p.jobLimit }} 个岗位</span>
              <small v-for="line in productQuotaLines(p)" :key="line" class="quota-line">{{line}}</small>
              <small v-if="productQuotaLines(p).length" class="quota-line">{{p.billingKind==='addon'?'一次到账':p.billingEntitlements?.grantPeriod==='monthly'?'每月发放 · '+(p.billingEntitlements.rollover?'结转至订阅到期':'当期到期失效'):'一次发放 · 订阅到期失效'}}</small>
              <small v-if="p.description" class="quota-line">{{p.description}}</small>
              <small v-if="capacityIssue(p,report.organization)" class="capacity-warning">{{capacityIssue(p,report.organization)}}</small>
              <span class="product-select">{{ productId === p.id ? '已选择' : '选择套餐' }}</span>
            </button>
          </div>
          <aside v-if="tab==='subscription'">
            同一套餐续费从当前到期日顺延；切换套餐从付款成功日开始。增购包仅增加额度，不改变席位、岗位和订阅期限。当前用量：{{
              report.organization.seatUsage
            }}
            个席位 / {{ report.organization.jobUsage }} 个岗位。
          </aside>
        </div>
        <form class="checkout-card" @submit.prevent="create">
          <h2>确认购买</h2>
          <p>{{ product?.name ?? "请选择套餐" }}</p>
          <p v-if="product" class="selected-details">{{ paymentDurationLabel(product) }}<template v-if="product.billingKind!=='addon'"> · {{ product.seatLimit }} 个席位 · {{ product.jobLimit }} 个岗位</template><template v-else> · 额度增购包</template><span v-if="product.allModules"> · 全部模块功能</span></p>
          <ul v-if="product" class="summary-quotas"><li v-for="line in productQuotaLines(product)" :key="line">{{line}}</li></ul>
          <p v-if="forecast">{{forecast.action}} · 预计生效 {{date(forecast.start.toISOString())}}<br />预计到期 {{date(forecast.end.toISOString())}}</p>
          <p v-if="issue" class="alert">{{issue}}</p>
          <strong class="total">{{
            product ? formatPayment(product.amountFen) : "—"
          }}</strong>
          <fieldset>
            <legend>支付方式</legend>
            <label v-if="allowedMethods.includes('alipay')"
              ><input
                v-model="method"
                type="radio"
                value="alipay"
              />支付宝</label
            ><label v-if="allowedMethods.includes('wxpay')"
              ><input
                v-model="method"
                type="radio"
                value="wxpay"
              />微信支付</label
            >
          </fieldset>
          <label
            >收款渠道<select v-model="providerId">
              <option v-for="p in providers" :key="p.id" :value="p.id">
                {{ p.name }}{{ p.environment === "sandbox" ? "（沙箱测试）" : "" }}
              </option>
            </select></label
          >
          <p v-if="!providers.length" class="empty">
            此支付方式尚未启用，暂不能付款。已选套餐不会产生扣款，请联系管理员配置收款渠道。
          </p>
          <fieldset v-if="method === 'wxpay'">
            <legend>付款模式</legend>
            <label
              ><input
                v-model="wechatMode"
                type="radio"
                value="qrcode"
              />扫码支付</label
            ><label
              ><input
                v-model="wechatMode"
                type="radio"
                value="redirect"
              />跳转支付</label
            >
          </fieldset>
          <p v-else-if="providers.length">付款模式：跳转支付</p>
          <p v-if="providers.find(p=>p.id===providerId)?.environment === 'sandbox'" class="alert">当前为沙箱测试，不会发放正式套餐权益。</p>
          <p v-if="method === 'wxpay' && wechatMode === 'redirect'">
            微信跳转支付适用于手机浏览器，电脑请使用扫码支付。
          </p>
          <p v-if="!report.canPurchase" class="alert">
            企业服务已暂停，请联系平台管理员。
          </p>
          <button
            class="primary"
            type="submit"
            :disabled="busy || !product || !providerId || !report.canPurchase || Boolean(pendingOrder) || Boolean(issue)"
          >
            {{ busy ? "正在创建订单…" : "创建订单并付款" }}
          </button>
        </form>
      </section>
      <section v-else class="order-card">
        <span class="eyebrow">{{
          order.method === "wxpay" ? "微信支付" : "支付宝"
        }}</span>
        <h2>{{ expiryClosing && !cancelling ? '关单待确认' : orderStatus(order) }}</h2>
        <p v-if="order.environment === 'sandbox'" class="alert">沙箱测试订单，不会发放正式套餐权益。</p>
        <p>{{ order.name }} · {{ paymentDurationLabel(order) }}</p>
        <strong class="total">{{ formatPayment(order.amountFen) }}</strong>
        <p class="order-number">订单号 {{ order.outTradeNo }}</p>
        <p v-if="cancelling" class="alert" role="status">{{ order.cancellationMessage || '取消申请已保存，正在等待支付渠道确认关闭订单，请勿继续付款。' }}</p>
        <p v-else-if="order.channelClosePending || expiryClosing" class="alert" role="status">渠道关单尚未确认，请勿继续支付旧订单。{{ order.cancellationMessage || '系统会继续核验，如发现付款将转入人工核对。' }}</p>
        <p v-else-if="paying && order.creationOutcome === 'not_created'" class="alert" role="status">{{ order.creationMessage || '支付订单创建失败，可直接取消后重试。' }}</p>
        <template v-if="paying && !cancelling && !expiryClosing && order.creationOutcome !== 'not_created'"
          ><p>付款剩余时间 {{ countdown }}</p>
          <img
            v-if="qr && seconds > 0"
            :src="qr"
            width="280"
            height="280"
            alt="订单付款二维码"
          /><a
            v-if="safePayURL && seconds > 0"
            class="primary pay-link"
            :href="safePayURL"
            rel="noreferrer noopener"
            >前往支付平台付款</a
          >
          <p v-if="order.status === 'uncertain'">
            渠道暂未确认创建结果。请先查询订单，避免重复付款。
          </p>
          <p>
            付款完成后将自动查询结果；请以本页确认的订单状态为准。
          </p></template
        >
        <p v-if="order.status === 'fulfilled'" class="success" role="status">
          {{order.billingKind==='addon'?'已确认到账，算力额度已发放至企业共享余额。':'已确认到账，企业套餐已经开通。'}}
        </p>
        <p v-if="order.reviewReason" class="alert">{{ order.reviewReason }}</p>
        <div class="actions">
          <button
            v-if="!terminal || order.channelClosePending"
            class="secondary"
            :disabled="busy"
            @click="action('verify')"
          >
            查询支付结果</button
          ><button
            v-if="paying && !cancelling && order.status !== 'creating'"
            class="secondary"
            :disabled="busy"
            @click="action('cancel')"
          >
            取消订单</button
          ><RouterLink
            class="secondary"
            :to="{ name: 'enterprise-payments', query: { workspace: org } }"
            >返回充值与订阅</RouterLink
          >
        </div>
      </section>
      <section class="history">
        <h2>企业订单</h2>
        <label class="history-filter">订单类型<select v-model="historyType"><option value="all">全部订单</option><option value="addon">算力充值</option><option value="subscription">服务订阅</option></select></label>
        <p v-if="!report.orders.length" class="empty">暂无付款订单</p>
        <div class="table-scroll">
          <table v-if="report.orders.length">
            <thead>
              <tr>
                <th>套餐 / 订单号</th>
                <th>金额</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in historyOrders" :key="r.id">
                <td>
                  {{ r.name }}<small>{{ r.outTradeNo }}</small>
                </td>
                <td>{{ formatPayment(r.amountFen) }}</td>
                <td>{{ orderStatus(r) }}</td>
                <td>{{ new Date(r.createdAt).toLocaleString() }}</td>
                <td>
                  <RouterLink
                    :to="{
                      name: 'enterprise-payment-order',
                      params: { id: r.id },
                      query: { workspace: org },
                    }"
                    >查看订单</RouterLink
                  >
                </td>
              </tr>
              <tr v-if="!historyOrders.length"><td colspan="5">暂无此类型订单</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
    <EnterpriseServicePanel v-if="org && !order" :organization-id="org" :initially-expanded="route.hash === '#enterprise-service'" />
  </main>
</template>
<style scoped>
.purchase-tabs{display:flex;gap:8px;border-bottom:1px solid #d5dfe5;margin-bottom:24px;padding-bottom:12px;align-items:center}
.purchase-tabs button{display:inline-flex;align-items:center;gap:8px;background:transparent;border:0;border-radius:6px;padding:12px 16px;font:inherit;color:#53636e;cursor:pointer;min-height:44px}
.purchase-tabs button.active{background:#e2f3ed;color:#176457;font-weight:700}
.purchase-tabs button.refresh{margin-left:auto;padding:12px}
.credit-balances{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;border-bottom:1px solid #d5dfe5;padding:0 0 24px;margin-bottom:28px}
.credit-balances>div{display:grid;gap:8px;min-width:0}
.credit-balances strong{font-size:28px;color:#216b61;overflow-wrap:anywhere}
.credit-balances small{font-family:inherit;font-size:12px;margin:0}
.subscription-current{display:flex;gap:16px 24px;flex-wrap:wrap;border-bottom:1px solid #d5dfe5;padding-bottom:24px;margin-bottom:28px;font-size:14px}
.product .quota-line{font-size:13px;line-height:1.65;font-family:inherit;margin:0;color:#53646a;overflow-wrap:anywhere}
.product .capacity-warning{color:#ad4532;font-family:inherit}
.summary-quotas{padding-left:20px;font-size:13px;color:#53646a;line-height:1.8}
.history-filter{display:flex;gap:10px;align-items:center;margin-bottom:16px;font-size:14px}
.history-filter select{padding:8px;border:1px solid #c3d1d9;border-radius:6px;background:white;font:inherit}
@media(max-width:500px){.credit-balances{gap:12px}.credit-balances strong{font-size:22px}.purchase-tabs button{padding:10px}.credit-balances small{line-height:1.8}}
.payment-page {
  max-width: 1180px;
  margin: auto;
  padding: 30px;
  color: #172b44;
  box-sizing: border-box;
  min-width: 0;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 28px;
}
h1 {
  font-size: 30px;
  margin: 8px 0;
}
h2 {
  font-size: 20px;
  margin: 0 0 18px;
}
p {
  line-height: 1.7;
  color: #52657b;
}
.eyebrow {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  color: #2771b7;
}
.purchase-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 28px;
}
.pending-order {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 18px;
  padding: 18px 0;
  margin-bottom: 24px;
  border-block: 1px solid #ccd8e5;
}
.pending-order > div { min-width: 0; }
.pending-order h2 { margin-bottom: 8px; }
.pending-order p { margin: 4px 0; }
.pending-order .primary { flex-shrink: 0; }
.products {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(190px, 100%), 1fr));
  gap: 16px;
}
.product {
  display: flex;
  flex-direction: column;
  gap: 16px;
  text-align: left;
  background: white;
  border: 2px solid #e3eaf2;
  border-radius: 8px;
  padding: 20px;
  color: inherit;
  cursor: pointer;
  min-width: 0;
  transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease, background .18s ease;
}
.product:hover { border-color: #81b4bc; box-shadow: 0 6px 18px #234c6510; transform: translateY(-2px); }
.product:active { transform: translateY(0) scale(.99); }
.product:focus-visible { outline: 3px solid #9ac8f0; outline-offset: 3px; }
.product.selected {
  border-color: #398a83;
  background: #f0faf6;
}
.product strong {
  font-size: 26px;
  color: #205e5b;
}
.product span {
  font-size: 14px;
  color: #52657b;
}
.product .product-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: #254858; font-size: 15px; }
.selection-indicator { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 18px; height: 18px; border: 1px solid #b9cdcd; border-radius: 50%; }
.selected .selection-indicator { color: white; background: #398a83; border-color: #398a83; }
.product-price { display: flex; align-items: baseline; flex-wrap: wrap; gap: 3px; }
.product .product-features { display: flex; align-items: center; gap: 6px; color: #287758; font-weight: 600; }
.product-detail { display: flex; align-items: center; gap: 8px; line-height: 1.6; }
.product-detail svg, .product-features svg { flex-shrink: 0; }
.product .product-select { display: block; margin-top: auto; padding-top: 14px; border-top: 1px solid #dbe8e7; color: #347d76; font-weight: 600; }
.selected-details { font-size: 13px; margin: 0; }
.checkout-card,
.order-card,
.history {
  background: white;
  border: 1px solid #e3eaf2;
  border-radius: 8px;
  padding: 26px;
}
.checkout-card {
  display: flex;
  flex-direction: column;
  gap: 18px;
  align-self: start;
  min-width: 0;
}
.checkout-card p,.checkout-card ul { margin: 0; }
.total {
  font-size: 36px;
  color: #165a99;
}
.checkout-card > label {
  display: grid;
  gap: 8px;
}
fieldset {
  border: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 12px 18px;
}
fieldset label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
legend {
  margin-bottom: 12px;
  font-weight: 600;
}
select {
  padding: 10px;
  border: 1px solid #ccd8e5;
  border-radius: 8px;
  background: white;
}
.primary,
.secondary {
  display: inline-block;
  padding: 11px 18px;
  border-radius: 8px;
  text-decoration: none;
  font: inherit;
  cursor: pointer;
}
.primary {
  background: #176bb3;
  color: white;
  border: 1px solid #176bb3;
}
.secondary {
  background: white;
  color: #27618f;
  border: 1px solid #cedbe7;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
aside,
.empty {
  background: #f4f7fb;
  padding: 18px;
  border-radius: 8px;
  margin-top: 20px;
  font-size: 14px;
  line-height: 1.7;
}
.order-card {
  text-align: center;
  max-width: 660px;
  margin: 0 auto 28px;
}
.order-card img {
  display: block;
  margin: 18px auto;
}
.order-number {
  font-family: monospace;
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
}
.alert {
  padding: 14px;
  background: #fff2ea;
  border-radius: 8px;
  color: #9c4219;
}
.success {
  color: #18764a;
}
.history {
  margin-top: 28px;
  border: 0;
  border-top: 1px solid #dce5ec;
  border-radius: 0;
  background: transparent;
  padding-inline: 0;
}
.table-scroll {
  overflow: auto;
}
table {
  width: 100%;
  min-width: 680px;
  border-collapse: collapse;
  text-align: left;
}
th,
td {
  padding: 14px 12px;
  border-bottom: 1px solid #edf0f5;
  font-size: 14px;
}
small {
  display: block;
  font-family: monospace;
  color: #758599;
  margin-top: 6px;
}
.pay-link {
  margin: 20px auto;
}
@media (max-width: 800px) {
  .purchase-layout {
    grid-template-columns: 1fr;
  }
  .payment-page {
    padding: 18px;
  }
  .products {
    grid-template-columns: 1fr;
  }
  header {
    align-items: flex-start;
    flex-direction: column;
    gap: 16px;
  }
}
</style>
