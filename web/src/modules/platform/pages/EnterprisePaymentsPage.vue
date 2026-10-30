<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import QRCode from "qrcode";
import { Check, CalendarDays, UsersRound, BriefcaseBusiness } from "@lucide/vue";
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
import { describeApiFailure } from "../../../shared/utils/errorMessage";
const route = useRoute(),
  router = useRouter(),
  report = ref<Checkout | null>(null),
  order = ref<PaymentOrder | null>(null);
const productId = ref(""),
  providerId = ref(""),
  method = ref<"wxpay" | "alipay">("alipay"),
  mode = ref<"qrcode" | "redirect">("qrcode");
const busy = ref(false),
  loading = ref(true),
  error = ref(""),
  qr = ref(""),
  seconds = ref(0);
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
let retry: {
    key: string;
    input: Parameters<typeof createPaymentOrder>[1];
  } | null = null,
  timer: ReturnType<typeof setInterval> | undefined,
  tick = 0,
  generation = 0;
let loadGeneration = 0;
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
        error.value = "二维码无法生成，请尝试跳转支付或联系管理员";
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
  try {
    const workspace = org.value,
      id = route.params.id;
    const data = await getCheckout(workspace);
    const current =
      typeof id === "string" ? await getPaymentOrder(workspace, id) : null;
    if (stamp !== loadGeneration) return;
    report.value = data;
    productId.value = data.products[0]?.id ?? "";
    order.value = current;
  } catch (e) {
    if (stamp === loadGeneration) fail(e);
  } finally {
    if (stamp === loadGeneration) loading.value = false;
  }
}
async function create() {
  if (busy.value || !productId.value || !providerId.value || !report.value)
    return;
  busy.value = true;
  error.value = "";
  const input = {
    productId: productId.value,
    providerId: providerId.value,
    method: method.value,
    mode: mode.value,
    expectedVersion: report.value.organization.entitlementVersion,
  };
  if (!retry || JSON.stringify(retry.input) !== JSON.stringify(input))
    retry = { key: crypto.randomUUID(), input };
  try {
    order.value = await createPaymentOrder(org.value, retry.input, retry.key);
    retry = null;
    await router.push({
      name: "enterprise-payment-order",
      params: { id: order.value.id },
      query: { workspace: org.value },
    });
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}
async function action(kind: "verify" | "cancel", quiet = false) {
  if (!order.value || busy.value) return;
  if (kind === "cancel" && !window.confirm("确认关闭此付款订单？")) return;
  busy.value = true;
  if (!quiet) error.value = "";
  try {
    const previous = order.value.status;
    order.value = await paymentOrderAction(org.value, order.value.id, kind);
    if (report.value)
      report.value.orders = report.value.orders.map((item) =>
        item.id === order.value!.id ? order.value! : item,
      );
    if (order.value.status === "fulfilled" && previous !== "fulfilled")
      await refreshAuthSession();
  } catch (e) {
    if (!quiet) fail(e);
  } finally {
    busy.value = false;
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
  () => route.fullPath,
  () => void load(),
);
onMounted(() => {
  void load();
  timer = setInterval(() => {
    seconds.value =
      Math.max(
        0,
        Math.ceil(
          (Date.parse(order.value?.expiresAt ?? "") - Date.now()) / 1000,
        ),
      ) || 0;
    if (++tick % 15 === 0 && order.value && !terminal.value)
      void action("verify", true);
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
        <span class="eyebrow">企业订阅</span>
        <h1>套餐订购与续费</h1>
        <p>
          {{ report?.organization.name ?? "企业付款中心" }} ·
          按企业开通招聘席位与岗位容量
        </p>
      </div>
      <RouterLink to="/workspaces" class="secondary">企业工作空间</RouterLink>
    </header>
    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">正在读取企业订单…</p>
    <template v-else-if="report">
      <section v-if="!order" class="purchase-layout">
        <div>
          <h2>选择适合团队的套餐</h2>
          <p v-if="!report.products.length" class="empty">
            暂无在售套餐，请联系平台管理员。
            <RouterLink v-if="authSession.user?.platformRole === 'admin'" to="/platform/payments">配置正式套餐</RouterLink>
          </p>
          <div class="products">
            <button
              v-for="p in report.products"
              :key="p.id"
              class="product"
              :class="{ selected: productId === p.id }"
              :aria-pressed="productId === p.id"
              :aria-label="p.name + '，' + formatPayment(p.amountFen) + '，' + paymentDurationLabel(p)"
              @click="productId = p.id"
            >
              <span class="product-heading"><b>{{ p.name }}</b><span class="selection-indicator"><Check v-if="productId === p.id" :size="14" aria-hidden="true" /></span></span>
              <span class="product-price"><strong>{{ formatPayment(p.amountFen) }}</strong><span v-if="priceUnit(p.durationMonths)"> / {{ priceUnit(p.durationMonths) }}</span></span>
              <span v-if="p.allModules" class="product-features"><Check :size="16" aria-hidden="true" />全部模块功能</span>
              <span class="product-detail"><CalendarDays :size="16" aria-hidden="true" />使用期限：{{ paymentDurationLabel(p) }}</span>
              <span class="product-detail"><UsersRound :size="16" aria-hidden="true" />{{ p.seatLimit }} 个席位</span>
              <span class="product-detail"><BriefcaseBusiness :size="16" aria-hidden="true" />{{ p.jobLimit }} 个岗位</span>
              <span class="product-select">{{ productId === p.id ? '已选择' : '选择套餐' }}</span>
            </button>
          </div>
          <aside>
            同一套餐续费从当前到期日顺延；切换套餐从付款成功日开始。当前用量：{{
              report.organization.seatUsage
            }}
            个席位 / {{ report.organization.jobUsage }} 个岗位。
          </aside>
        </div>
        <form class="checkout-card" @submit.prevent="create">
          <h2>确认购买</h2>
          <p>{{ product?.name ?? "请选择套餐" }}</p>
          <p v-if="product" class="selected-details">{{ paymentDurationLabel(product) }} · {{ product.seatLimit }} 个席位 · {{ product.jobLimit }} 个岗位<span v-if="product.allModules"> · 全部模块功能</span></p>
          <strong class="total">{{
            product ? formatPayment(product.amountFen) : "—"
          }}</strong>
          <fieldset>
            <legend>支付方式</legend>
            <label
              ><input
                v-model="method"
                type="radio"
                value="alipay"
              />支付宝</label
            ><label
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
                {{ p.name }}
              </option>
            </select></label
          >
          <p v-if="!providers.length" class="empty">
            此支付方式尚未启用，暂不能付款。已选套餐不会产生扣款，请联系管理员配置收款渠道。
          </p>
          <fieldset>
            <legend>付款模式</legend>
            <label
              ><input
                v-model="mode"
                type="radio"
                value="qrcode"
              />扫码支付</label
            ><label
              ><input
                v-model="mode"
                type="radio"
                value="redirect"
              />跳转支付</label
            >
          </fieldset>
          <p v-if="method === 'wxpay' && mode === 'redirect'">
            微信跳转支付适用于手机浏览器，电脑请使用扫码支付。
          </p>
          <p v-if="!report.canPurchase" class="alert">
            企业服务已暂停，请联系平台管理员。
          </p>
          <button
            class="primary"
            type="submit"
            :disabled="busy || !product || !providerId || !report.canPurchase"
          >
            {{ busy ? "正在创建订单…" : "创建订单并付款" }}
          </button>
        </form>
      </section>
      <section v-else class="order-card">
        <span class="eyebrow">{{
          order.method === "wxpay" ? "微信支付" : "支付宝"
        }}</span>
        <h2>{{ paymentStatusLabel[order.status] }}</h2>
        <p>{{ order.name }} · {{ order.durationDays }} 天</p>
        <strong class="total">{{ formatPayment(order.amountFen) }}</strong>
        <p class="order-number">订单号 {{ order.outTradeNo }}</p>
        <template v-if="paying"
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
          已确认到账，企业套餐已经开通。
        </p>
        <p v-if="order.reviewReason" class="alert">{{ order.reviewReason }}</p>
        <div class="actions">
          <button
            v-if="!terminal"
            class="secondary"
            :disabled="busy"
            @click="action('verify')"
          >
            查询支付结果</button
          ><button
            v-if="paying && order.status !== 'creating'"
            class="secondary"
            :disabled="busy"
            @click="action('cancel')"
          >
            取消订单</button
          ><RouterLink
            class="secondary"
            :to="{ name: 'enterprise-payments', query: { workspace: org } }"
            >返回套餐列表</RouterLink
          >
        </div>
      </section>
      <section class="history">
        <h2>企业订单</h2>
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
              <tr v-for="r in report.orders" :key="r.id">
                <td>
                  {{ r.name }}<small>{{ r.outTradeNo }}</small>
                </td>
                <td>{{ formatPayment(r.amountFen) }}</td>
                <td>{{ paymentStatusLabel[r.status] }}</td>
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
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </main>
</template>
<style scoped>
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
  letter-spacing: 2px;
  color: #2771b7;
}
.purchase-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 28px;
}
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
  gap: 18px;
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
  border-radius: 10px;
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
}
.table-scroll {
  overflow: auto;
}
table {
  width: 100%;
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
