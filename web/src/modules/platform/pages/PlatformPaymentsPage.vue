<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { authSession } from "../../auth/session";
import { listPlans, type PlanVersion } from "../api/entitlements";
import {
  getPaymentAdmin,
  publishPaymentProduct,
  addPaymentProvider,
  togglePaymentItem,
  adminPaymentAction,
  formatPayment,
  paymentDurationLabel,
  paymentStatusLabel,
  type PaymentAdmin,
  type PaymentChannel,
  type PaymentOrder,
} from "../api/payments";
import { describeApiFailure } from "../../../shared/utils/errorMessage";
const report = ref<PaymentAdmin | null>(null),
  plans = ref<PlanVersion[]>([]),
  busy = ref(false),
  error = ref(""),
  notice = ref("");
const canWrite = computed(() => authSession.user?.platformRole === "admin");
const product = reactive({
  planVersionId: "",
  name: "",
  price: "",
  durationDays: 30,
  durationMonths: 1,
  periodUnit: "days" as "days" | "months",
  allModules: false,
  reason: "",
});
const channel = reactive({
  name: "",
  kind: "alipay" as PaymentChannel["kind"],
  reason: "",
  config: {} as Record<string, string>,
});
const fields: Record<PaymentChannel["kind"], [string, string][]> = {
  alipay: [
    ["appId", "应用 App ID"],
    ["sellerId", "收款方 seller_id"],
    ["privateKey", "应用 RSA 私钥（PEM）"],
    ["publicKey", "支付宝公钥（PEM）"],
  ],
  wxpay: [
    ["appId", "App ID"],
    ["mchId", "商户号"],
    ["certSerial", "商户证书序列号"],
    ["privateKey", "商户 RSA 私钥（PEM）"],
    ["apiV3Key", "API v3 Key"],
    ["publicKeyId", "微信支付公钥 ID"],
    ["publicKey", "微信支付公钥（PEM）"],
  ],
  easypay: [
    ["apiBase", "接口 HTTPS 地址"],
    ["pid", "商户 PID"],
    ["pkey", "商户密钥"],
  ],
};
watch(
  () => channel.kind,
  () => {
    channel.config = {};
  },
);
const secret = (key: string) =>
  ["privateKey", "apiV3Key", "pkey"].includes(key);
async function load() {
  try {
    [report.value, plans.value] = await Promise.all([
      getPaymentAdmin(),
      listPlans(),
    ]);
    plans.value = plans.value.filter((p) => p.code !== "legacy");
  } catch (e) {
    error.value = describeApiFailure(e, "读取支付管理失败").message;
  }
}
async function run(fn: () => Promise<unknown>, success: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
    notice.value = success;
    await load();
  } catch (e) {
    error.value = describeApiFailure(e, "操作失败").message;
  } finally {
    busy.value = false;
  }
}
async function publish() {
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(product.price)) {
    error.value = "请输入最多两位小数的人民币售价";
    return;
  }
  const [yuan, fraction = ""] = product.price.split("."),
    amountFen = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  await run(
    () =>
      publishPaymentProduct({
        planVersionId: product.planVersionId,
        name: product.name,
        amountFen,
        durationDays: product.durationDays,
        ...(product.periodUnit === "months"
          ? { durationDays: null, durationMonths: product.durationMonths }
          : {}),
        ...(product.allModules ? { allModules: true } : {}),
        reason: product.reason,
      }),
    "新售价版本已发布，请确认后上架",
  );
}
async function saveChannel() {
  await run(async () => {
    await addPaymentProvider({ ...channel, config: { ...channel.config } });
    channel.config = {};
    channel.name = "";
    channel.reason = "";
  }, "支付配置已加密保存，请确认后启用");
}
async function toggle(
  kind: "products" | "providers",
  id: string,
  value: boolean,
) {
  const reason = window.prompt("请输入此次上下架 / 启停的操作原因");
  if (!reason) return;
  await run(
    () =>
      togglePaymentItem(
        kind,
        id,
        kind === "products"
          ? { active: value, reason }
          : { enabled: value, reason },
      ),
    "状态已更新",
  );
}
async function orderAction(order: PaymentOrder, action: "verify" | "refund") {
  let reason: string | undefined;
  if (action === "refund") {
    reason =
      window.prompt(
        `确认对 ${order.outTradeNo} 全额退款 ${formatPayment(order.amountFen)}？请输入原因。`,
      ) ?? undefined;
    if (!reason) return;
  }
  await run(
    () => adminPaymentAction(order.id, action, reason),
    action === "refund" ? "退款请求已提交，请以订单退款状态为准" : "订单已查询",
  );
}
onMounted(() => void load());
</script>
<template>
  <main class="management">
    <header>
      <div>
        <span class="eyebrow">平台运营</span>
        <h1>支付与商品管理</h1>
        <p>管理企业套餐售价、收款渠道与订单退款。</p>
      </div>
      <button class="secondary" :disabled="busy" @click="load">刷新</button>
    </header>
    <p v-if="error" role="alert" class="alert">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <template v-if="report">
      <aside v-if="!report.keyConfigured || !report.publicBaseURL">
        {{ !report.keyConfigured ? "支付加密主密钥尚未配置。 " : ""
        }}{{
          !report.publicBaseURL ? "请配置支付公网 HTTPS 地址后启用渠道。" : ""
        }}
      </aside>
      <section>
        <h2>商品与定价</h2>
        <p>
          售价版本发布后不可修改；调价请发布新版本并下架旧版本，已有订单保持原价。套餐容量在「企业客户管理
          → 套餐权益」发布。
        </p>
        <form v-if="canWrite" class="product-form" @submit.prevent="publish">
          <label
            >套餐容量版本<select v-model="product.planVersionId" required>
              <option value="" disabled>选择套餐</option>
              <option v-for="p in plans" :key="p.id" :value="p.id">
                {{ p.name }} v{{ p.version }} · {{ p.seatLimit }} 席位 /
                {{ p.jobLimit }} 岗位
              </option>
            </select></label
          ><label
            >商品名称<input
              v-model="product.name"
              required
              minlength="2"
              maxlength="80" /></label
          ><label
            >售价（元）<input
              v-model="product.price"
              required
              inputmode="decimal"
              placeholder="例如 299.00" /></label
          ><label
            >计费期限<select v-model="product.periodUnit"><option value="days">按天</option><option value="months">按自然月</option></select></label
          ><label v-if="product.periodUnit === 'days'"
            >有效天数<input
              v-model.number="product.durationDays"
              required
              type="number"
              min="1"
              max="3660" /></label
          ><label v-else
            >有效月数<input v-model.number="product.durationMonths" required type="number" min="1" max="120" /></label
          ><label class="module-option"><input v-model="product.allModules" type="checkbox" />全部模块功能</label
          ><label
            >发布原因<input
              v-model="product.reason"
              required
              minlength="2"
              maxlength="500" /></label
          ><button class="primary" :disabled="busy">发布售价版本</button>
        </form>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>商品</th>
                <th>售价 / 期限</th>
                <th>容量</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in report.products" :key="p.id">
                <td>{{ p.name }}</td>
                <td>
                  {{ formatPayment(p.amountFen) }} / {{ paymentDurationLabel(p) }}
                </td>
                <td>{{ p.seatLimit }} 席位 / {{ p.jobLimit }} 岗位</td>
                <td>{{ p.active ? "在售" : "已下架" }}</td>
                <td>
                  <button
                    v-if="canWrite"
                    class="secondary"
                    :disabled="busy"
                    @click="toggle('products', p.id, !p.active)"
                  >
                    {{ p.active ? "下架" : "上架" }}
                  </button>
                </td>
              </tr>
              <tr v-if="!report.products.length">
                <td colspan="5">暂无商品，请先发布套餐售价。</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h2>收款渠道</h2>
        <p>
          支持微信 API v3、支付宝 RSA2 和
          EasyPay。新配置默认停用；密钥加密存储且不回显。轮换密钥请新增渠道版本，旧订单继续使用原配置。
        </p>
        <div class="channels">
          <article v-for="p in report.providers" :key="p.id">
            <b>{{ p.name }}</b
            ><span>{{ p.kind }} · {{ p.enabled ? "已启用" : "已停用" }}</span
            ><button
              v-if="canWrite"
              class="secondary"
              :disabled="busy"
              @click="toggle('providers', p.id, !p.enabled)"
            >
              {{ p.enabled ? "停用" : "启用" }}
            </button>
          </article>
        </div>
        <details v-if="canWrite">
          <summary>新增收款渠道</summary>
          <form
            class="channel-form"
            autocomplete="off"
            @submit.prevent="saveChannel"
          >
            <label
              >渠道名称<input
                v-model="channel.name"
                required
                minlength="2"
                maxlength="80" /></label
            ><label
              >接口类型<select v-model="channel.kind">
                <option value="alipay">支付宝官方</option>
                <option value="wxpay">微信支付官方</option>
                <option value="easypay">EasyPay 聚合支付</option>
              </select></label
            ><label v-for="[key, label] in fields[channel.kind]" :key="key"
              >{{ label
              }}<textarea
                v-if="
                  key.includes('Key') &&
                  key !== 'apiV3Key' &&
                  key !== 'publicKeyId'
                "
                v-model="channel.config[key]"
                :aria-label="label"
                required
                rows="4"
                spellcheck="false" /><input
                v-else
                v-model="channel.config[key]"
                :aria-label="label"
                required
                :type="secret(key) ? 'password' : 'text'"
                autocomplete="off" /></label
            ><label
              >操作原因<input
                v-model="channel.reason"
                required
                minlength="2"
                maxlength="500" /></label
            ><button class="primary" :disabled="busy || !report.keyConfigured">
              加密保存渠道
            </button>
          </form>
        </details>
      </section>
      <section>
        <h2>最新订单</h2>
        <p>
          已付款但未发放的订单会显示「待人工核对」。退款为全额退款；退款结果不确定时保留原退款单号继续查询。
        </p>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>企业 / 订单号</th>
                <th>商品</th>
                <th>金额</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in report.orders" :key="o.id">
                <td>
                  {{ o.organizationName }}<small>{{ o.outTradeNo }}</small>
                </td>
                <td>{{ o.name }}</td>
                <td>{{ formatPayment(o.amountFen) }}</td>
                <td>
                  {{ paymentStatusLabel[o.status]
                  }}<small v-if="o.reviewReason">{{ o.reviewReason }}</small>
                </td>
                <td class="actions">
                  <button
                    v-if="canWrite"
                    class="secondary"
                    :disabled="busy"
                    @click="orderAction(o, 'verify')"
                  >
                    查询渠道</button
                  ><button
                    v-if="
                      canWrite && ['fulfilled', 'review'].includes(o.status)
                    "
                    class="danger"
                    :disabled="busy"
                    @click="orderAction(o, 'refund')"
                  >
                    全额退款
                  </button>
                </td>
              </tr>
              <tr v-if="!report.orders.length">
                <td colspan="5">暂无正式付款订单</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </main>
</template>
<style scoped>
.management {
  max-width: 1280px;
  padding: 28px;
  margin: auto;
  color: #183049;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.eyebrow {
  font-size: 12px;
  letter-spacing: 2px;
  color: #2771b7;
}
h1 {
  margin: 8px 0;
  font-size: 28px;
}
h2 {
  font-size: 20px;
  margin: 0 0 14px;
}
p {
  color: #62748a;
  line-height: 1.7;
}
section {
  background: white;
  border: 1px solid #e3eaf2;
  border-radius: 14px;
  padding: 24px;
  margin-top: 24px;
}
.product-form {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin: 20px 0;
}
.channel-form {
  max-width: 720px;
  display: grid;
  gap: 16px;
  margin-top: 20px;
}
label {
  display: grid;
  gap: 8px;
  font-size: 14px;
}
.module-option { display: flex; align-items: center; gap: 8px; align-self: end; min-height: 42px; }
input,
select,
textarea {
  padding: 10px;
  border: 1px solid #ced9e6;
  border-radius: 8px;
  font: inherit;
  background: white;
}
textarea {
  font-family: monospace;
  resize: vertical;
}
.primary,
.secondary,
.danger {
  padding: 10px 14px;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
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
.danger {
  background: #fff4f4;
  color: #a82a2a;
  border: 1px solid #f0caca;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
  font-size: 14px;
  padding: 13px 10px;
  border-bottom: 1px solid #edf0f5;
}
small {
  display: block;
  color: #6e7f92;
  margin-top: 6px;
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  gap: 8px;
}
.channels {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin: 18px 0;
}
.channels article {
  display: grid;
  gap: 10px;
  border: 1px solid #e3eaf2;
  border-radius: 10px;
  padding: 18px;
  min-width: 190px;
}
summary {
  cursor: pointer;
  font-weight: 600;
}
aside,
.alert {
  background: #fff2e7;
  color: #914419;
  padding: 14px;
  border-radius: 8px;
}
.notice {
  background: #eaf7ef;
  color: #217546;
  padding: 14px;
  border-radius: 8px;
}
@media (max-width: 800px) {
  .product-form {
    grid-template-columns: 1fr;
  }
  .management {
    padding: 16px;
  }
}
</style>
