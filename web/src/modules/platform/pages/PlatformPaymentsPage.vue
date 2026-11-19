<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch, toRaw } from "vue";
import EnterpriseServiceThread from "../components/EnterpriseServiceThread.vue";
import AlipayBillPanel from "../components/AlipayBillPanel.vue";
import BillingPolicyPanel from "../components/BillingPolicyPanel.vue";
import CreditConversionPanel from "../components/CreditConversionPanel.vue";
import PaymentProductDialog from '../components/PaymentProductDialog.vue';
import { Pencil, Copy, History, Merge, Plus, RefreshCw } from '@lucide/vue';
import { authSession } from "../../auth/session";
import {
  getPaymentAdmin,
  publishPaymentProduct,
  revisePaymentProduct,
  getPaymentProductHistory,
  mergePaymentProducts,
  type PaymentProductHistory,
  type PublishPaymentProductInput,
  addPaymentProvider,
  togglePaymentItem,
  adminPaymentAction,
  formatPayment,
  paymentDurationLabel,
  paymentStatusLabel,
  type PaymentAdmin,
  type PaymentProduct,
  type PaymentChannel,
  type PaymentOrder,
} from "../api/payments";
import { toBillingDisplay, toBillingStorage, formatBillingAmount } from '../utils/billingUnits';
import { describeApiFailure } from "../../../shared/utils/errorMessage";
const report = ref<PaymentAdmin | null>(null),
  busy = ref(false),
  error = ref(""),
  notice = ref("");
const canWrite = computed(() => authSession.user?.isSystemAdmin === true);
const product = reactive({
  seatLimit: 10,
  jobLimit: 100,
  name: "",
  description: '',
  sortOrder: 0,
  permanent: true,
  price: "",
  durationDays: 30,
  durationMonths: 1,
  periodUnit: "days" as "days" | "months",
  billingKind: 'subscription' as 'subscription'|'addon',
  aiPoints: 0,
  interviewMinutes: 0,
  ocrPages: 0,
  grantPeriod: 'monthly' as 'once'|'monthly',
  rollover: false,
  reason: "",
  allModules: false,
});
const editingProduct=ref<PaymentProduct|null>(null);
const productMode=ref<'new'|'edit'|'copy'>('new');
const submitId=ref(crypto.randomUUID());
const pendingProduct=ref<PublishPaymentProductInput|null>(null);
const history=ref<PaymentProductHistory|null>(null);
const historyLoading=ref(false);
const productSelection=ref<string[]>([]);
const merging=ref(false);
const mergeKeep=ref('');
const mergeActive=ref(false);
const mergeReason=ref('');
const mergeRequestId=ref('');
const mergeItems=ref<PaymentProduct[]>([]);
const productVersioning=computed(()=>report.value?.productVersioning===true);
const productDiff=computed(()=>{
  if (!pendingProduct.value || !editingProduct.value) return [];
  const next=pendingProduct.value,old=editingProduct.value;
  const entries:[string,unknown,unknown][]=[
    ['商品名称',old.name,next.name],['售价',formatPayment(old.amountFen),formatPayment(next.amountFen)],
    ['有效期',paymentDurationLabel(old),paymentDurationLabel({...old,...next,durationDays:next.durationDays??null})],
    ['席位数',old.billingKind==='addon'?'不适用':old.seatLimit,next.billingKind==='addon'?'不适用':next.seatLimit],
    ['岗位数',old.billingKind==='addon'?'不适用':old.jobLimit,next.billingKind==='addon'?'不适用':next.jobLimit],
    ['AI 点数',old.billingEntitlements?.quotas.ai_points??0,next.billingEntitlements?.quotas.ai_points??0],
    ['转写分钟数',formatBillingAmount(old.billingEntitlements?.quotas.interview_seconds??0,'interview_seconds'),formatBillingAmount(next.billingEntitlements?.quotas.interview_seconds??0,'interview_seconds')],
    ['OCR 页数',old.billingEntitlements?.quotas.ocr_pages??0,next.billingEntitlements?.quotas.ocr_pages??0],
    ['额度发放',old.billingEntitlements?.grantPeriod==='monthly'?'按月发放':'一次发放',next.billingEntitlements?.grantPeriod==='monthly'?'按月发放':'一次发放'],
    ['未用额度结转',old.billingEntitlements?.rollover?'是':'否',next.billingEntitlements?.rollover?'是':'否'],
    ['商品说明',old.description??'',next.description??''],['展示顺序',old.sortOrder??0,next.sortOrder??0],
  ];
  return entries.filter(([,a,b])=>a!==b);
});
const channel = reactive({
  name: "",
  kind: "alipay" as PaymentChannel["kind"],
  reason: "",
  config: { environment: "production" } as Record<string, string>,
});
const previewQuotas=computed(()=>[
  product.aiPoints>0?`${product.aiPoints.toLocaleString('zh-CN')} AI 点数`:'',
  product.interviewMinutes>0?`${product.interviewMinutes.toLocaleString('zh-CN',{maximumFractionDigits:6})} 分钟转写`:'',
  product.ocrPages>0?`${product.ocrPages.toLocaleString('zh-CN')} 页 OCR`:'',
].filter(Boolean));
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
    channel.config = channel.kind === "alipay" ? {environment:"production"} : {};
  },
);
const channelError = ref("");
const channelNotice = ref("");
const channelSaving = ref(false);
const activeModule = ref("products");
const paymentModules = [
  { id: 'billing', label: '算力与试用规则' },
  { id: 'service', label: '企业服务工单' },
  { id: 'duplicates', label: '重复待支付订单' },
  { id: 'products', label: '商品与定价' },
  { id: 'channels', label: '收款渠道' },
  { id: 'orders', label: '最新订单' },
  { id: 'reconciliation', label: '支付宝账单对账' },
];
function navigateModule(event: KeyboardEvent, index: number) {
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % paymentModules.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + paymentModules.length) % paymentModules.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = paymentModules.length - 1;
  else return;
  event.preventDefault();
  activeModule.value = paymentModules[next]!.id;
  (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
}
const revealedKeys = reactive<Record<string, boolean>>({});
const secret = (key: string) =>
  ["privateKey", "publicKey", "apiV3Key", "pkey"].includes(key);
const multilineKey = (key: string) => ["privateKey", "publicKey"].includes(key);
function hideKeys() {
  for (const key of Object.keys(revealedKeys)) delete revealedKeys[key];
}
function pasteKey(event: ClipboardEvent, key: string) {
  const text = event.clipboardData?.getData("text/plain");
  if (text !== undefined) {
    event.preventDefault();
    channel.config[key] = text;
  }
}
watch(() => channel.kind, () => {
  hideKeys();
  channelError.value = "";
  channelNotice.value = "";
});
async function load() {
  if (!canWrite.value) return;
  try {
    report.value = await getPaymentAdmin();
  } catch (e) {
    error.value = describeApiFailure(e, "读取支付管理失败").message;
  }
}
async function run(fn: () => Promise<unknown>, success: string) {
  if (busy.value) return false;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
    notice.value = success;
    await load();
    return true;
  } catch (e) {
    error.value = describeApiFailure(e, "操作失败").message;
    return false;
  } finally {
    busy.value = false;
  }
}
watch(()=>product.billingKind,value=>{if(value==='addon'){product.grantPeriod='once';product.rollover=false;product.allModules=false}});
function copyProduct(item:PaymentProduct,mode:'edit'|'copy'='copy',current:PaymentProduct=item){
  editingProduct.value=mode==='edit'?structuredClone(toRaw(current)):null;
  productMode.value=mode;submitId.value=crypto.randomUUID();
  product.billingKind=item.billingKind ?? 'subscription'; product.name=item.name; product.price=(item.amountFen/100).toFixed(2);
  product.description=item.description ?? '';product.sortOrder=item.sortOrder ?? 0;product.permanent=item.durationDays==null && item.durationMonths==null;
  product.seatLimit=item.seatLimit;product.jobLimit=item.jobLimit;product.allModules=item.allModules??false;product.durationDays=item.durationDays ?? 30;product.durationMonths=item.durationMonths ?? 1;product.periodUnit=item.durationMonths ? 'months':'days';
  product.aiPoints=item.billingEntitlements?.quotas?.ai_points ?? 0;product.interviewMinutes=toBillingDisplay(item.billingEntitlements?.quotas?.interview_seconds ?? 0,'interview_seconds');product.ocrPages=item.billingEntitlements?.quotas?.ocr_pages ?? 0;
  product.grantPeriod=item.billingKind==='addon'?'once':item.billingEntitlements?.grantPeriod ?? 'once';product.rollover=item.billingEntitlements?.rollover ?? false;product.reason='';
  document.querySelector('.product-form')?.scrollIntoView?.({behavior:'smooth',block:'start'});
}
function resetProduct(){
  editingProduct.value=null;productMode.value='new';submitId.value=crypto.randomUUID();pendingProduct.value=null;
  Object.assign(product,{seatLimit:10,jobLimit:100,name:'',description:'',sortOrder:0,permanent:true,price:'',durationDays:30,durationMonths:1,periodUnit:'days',billingKind:'subscription',aiPoints:0,interviewMinutes:0,ocrPages:0,grantPeriod:'monthly',rollover:false,reason:'',allModules:false});
}
async function showHistory(item:PaymentProduct){
  if (historyLoading.value) return;
  historyLoading.value=true;error.value='';
  try {history.value=await getPaymentProductHistory(item.id)} catch(e){error.value=describeApiFailure(e,'读取历史版本失败').message} finally {historyLoading.value=false}
}
function restoreProduct(item:PaymentProduct){
  const current=history.value?.versions.find(p=>p.id===history.value?.currentVersionId);
  if (!current) return;
  copyProduct(item,'edit',current);product.reason=`以第 ${item.versionNumber} 版配置恢复`;history.value=null;
}
function startMerge(){
  mergeItems.value=(report.value?.products??[]).filter(p=>productSelection.value.includes(p.id)).map(p=>structuredClone(toRaw(p)));
  if (mergeItems.value.length<2) return;
  if (new Set(mergeItems.value.map(p=>p.billingKind??'subscription')).size>1){error.value='订阅套餐和算力增购包不能归并';return}
  mergeKeep.value='';mergeReason.value='';mergeActive.value=false;mergeRequestId.value=crypto.randomUUID();merging.value=true;
}
async function confirmMerge(){
  const ok=await run(()=>mergePaymentProducts({versionIds:mergeItems.value.map(p=>p.id),keepVersionId:mergeKeep.value,active:mergeActive.value,reason:mergeReason.value,requestId:mergeRequestId.value}),'商品已归并，历史版本和原订单已保留');
  if(ok){merging.value=false;productSelection.value=[];resetProduct()}
}
async function publish() {
  if (!productVersioning.value || busy.value) return;
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(product.price)) {
    error.value = "请输入最多两位小数的人民币售价";
    return;
  }
  const [yuan, fraction = ""] = product.price.split("."),
    amountFen = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  const input:PublishPaymentProductInput={
        ...(product.billingKind==='subscription' ? {seatLimit:product.seatLimit,jobLimit:product.jobLimit} : {}),
        name: product.name,
        description: product.description,
        sortOrder: product.sortOrder,
        amountFen,
        ...(product.billingKind==='addon' && product.permanent ? {durationDays:null,durationMonths:null} : product.periodUnit === "months"
          ? { durationDays: null, durationMonths: product.durationMonths }
          : {durationDays:product.durationDays,durationMonths:null}),
        billingKind: product.billingKind,
        billingEntitlements: {quotas:{ai_points:product.aiPoints,interview_seconds:toBillingStorage(product.interviewMinutes,'interview_seconds'),ocr_pages:product.ocrPages},grantPeriod:product.billingKind==='addon'?'once':product.grantPeriod,rollover:product.billingKind==='addon'?false:product.rollover},
        reason: product.reason,
        ...(product.allModules?{allModules:true}:{}),
        requestId:submitId.value,
        ...(editingProduct.value?{expectedVersionId:editingProduct.value.id}:{}),
      };
  if (editingProduct.value){pendingProduct.value=input;return}
  const ok=await run(()=>publishPaymentProduct(input),'新商品已创建，确认后可上架');
  if(ok)resetProduct();
}
async function confirmRevision(){
  const input=pendingProduct.value,current=editingProduct.value;
  if(!input||!current)return;
  const ok=await run(()=>revisePaymentProduct(current.id,input),'原商品已更新并上架，旧版本及历史订单已保留');
  if(ok)resetProduct();
}
async function saveChannel(event: Event) {
  if (busy.value) return;
  channelError.value = "";
  channelNotice.value = "";
  if (!report.value?.keyConfigured) {
    channelError.value = "服务器尚未配置支付加密主密钥，暂时无法保存收款渠道，请先完成服务器配置。";
    return;
  }
  const form = event.currentTarget as HTMLFormElement;
  const invalid = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")]
    .find(field => !field.checkValidity() || !field.value.trim()
      || (field.minLength > 0 && field.value.trim().length < field.minLength)
      || (field.maxLength > 0 && field.value.length > field.maxLength));
  if (invalid) {
    const label = invalid.getAttribute("aria-label") ?? "必填信息";
    channelError.value = invalid.value.trim() ? "请检查「" + label + "」的长度或格式。" : "请填写「" + label + "」。";
    invalid.focus();
    invalid.reportValidity();
    return;
  }
  busy.value = true;
  channelSaving.value = true;
  error.value = "";
  notice.value = "";
  try {
    await addPaymentProvider({
      name: channel.name.trim(), kind: channel.kind, reason: channel.reason.trim(),
      config: { ...channel.config },
    });
    channel.config = channel.kind === "alipay" ? { environment: "production" } : {};
    channel.name = "";
    channel.reason = "";
    hideKeys();
    channelNotice.value = "收款渠道已加密保存，当前为停用状态；请在渠道列表确认后启用。密钥输入已清空。";
    await load();
  } catch (e) {
    hideKeys();
    const failure = describeApiFailure(e, "保存收款渠道失败，请稍后重试");
    const requestId = typeof e === "object" && e !== null && "requestId" in e && typeof e.requestId === "string" ? e.requestId : "";
    const safeRequestId = /^[A-Za-z0-9_-]{1,80}$/.test(requestId) ? requestId : "";
    const failureMessage = failure.status !== undefined && failure.status >= 500 && failure.message === "操作失败，请稍后重试"
      ? "保存收款渠道失败，请稍后重试"
      : failure.message;
    channelError.value = failureMessage + (failure.status !== undefined && failure.status >= 500 && safeRequestId ? `（错误编号：${safeRequestId}）` : "");
  } finally {
    busy.value = false;
    channelSaving.value = false;
  }
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
async function orderAction(order: PaymentOrder, action: "verify" | "refund" | "cancel") {
  let reason: string | undefined;
  if (action === "refund") {
    reason =
      window.prompt(
        `确认对 ${order.outTradeNo} 全额退款 ${formatPayment(order.amountFen)}？请输入原因。`,
      ) ?? undefined;
    if (!reason) return;
  }
  if (action === 'cancel') {
    reason = window.prompt(`核对并关闭 ${order.outTradeNo}？渠道已付款的订单会先处理到账。请输入关闭原因。`) ?? undefined;
    if (!reason) return;
  }
  await run(
    () => adminPaymentAction(order.id, action, reason),
    action === "refund" ? "退款请求已提交，请以订单退款状态为准" : action === 'cancel' ? '订单已核对，请检查最终状态' : "订单已查询",
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
      </div>
      <button class="secondary" :disabled="busy" @click="load"><RefreshCw :size="16" aria-hidden="true" />刷新</button>
    </header>
    <nav class="module-tabs" role="tablist" aria-label="支付管理模块">
      <button v-for="(module, index) in paymentModules" :id="`payment-tab-${module.id}`" :key="module.id"
        type="button" role="tab" :data-module="module.id" :aria-selected="activeModule === module.id"
        :aria-controls="`payment-panel-${module.id}`" :tabindex="activeModule === module.id ? 0 : -1"
        @click="activeModule = module.id" @keydown="navigateModule($event, index)">{{ module.label }}</button>
    </nav>
    <p v-if="error" role="alert" class="alert">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <div :id="`payment-panel-${activeModule}`" role="tabpanel" :aria-labelledby="`payment-tab-${activeModule}`" tabindex="0" class="module-content">
    <template v-if="report">
      <BillingPolicyPanel v-if="canWrite && activeModule === 'billing'" />
      <section v-if="activeModule === 'service'" aria-label="企业服务工单">
        <h2>企业服务工单</h2>
        <p>显示最近 100 条，待处理工单优先；企业成员可查看回复。</p>
        <article v-for="request in report.serviceRequests ?? []" :key="request.id" class="service-request">
          <strong>{{ request.organizationName }} · {{ request.status === 'open' ? '待处理' : '已回复' }}</strong>
          <p style="white-space: pre-wrap; overflow-wrap: anywhere">{{ request.message }}</p>
          <p v-if="request.response" style="white-space: pre-wrap; overflow-wrap: anywhere">回复：{{ request.response }}</p>
          <EnterpriseServiceThread v-if="canWrite" :request-id="request.id" @changed="load" />
        </article>
        <p v-if="!report.serviceRequests?.length">暂无服务工单</p>
      </section>
      <section v-if="activeModule === 'duplicates'" aria-label="重复待支付订单">
        <h2>历史重复待支付订单</h2>
        <p>最多列出 100 家企业。请逐单查询渠道，保留一张订单后关闭其余未付款订单；已付款订单会先处理到账。</p>
        <div v-for="group in report.duplicatePendingOrders" :key="group.organizationId">
          <h3>{{ group.organizationName }} · {{ group.orders.length }} 张待支付订单</h3>
          <article v-for="item in group.orders" :key="item.id">
            <p>{{ item.outTradeNo }} · {{ formatPayment(item.amountFen) }} · {{ paymentStatusLabel[item.status] }}</p>
            <button class="secondary" :disabled="busy" @click="orderAction(item, 'verify')">查询渠道</button>
            <button v-if="canWrite && ['pending','uncertain'].includes(item.status)" class="danger" :disabled="busy" @click="orderAction(item, 'cancel')">核对并关闭重复订单</button>
          </article>
        </div>
        <p v-if="!report.duplicatePendingOrders?.length">暂无重复待支付订单</p>
      </section>
      <aside v-if="activeModule === 'channels' && (!report.keyConfigured || !report.publicBaseURL)">
        {{ !report.keyConfigured ? "支付加密主密钥尚未配置。 " : ""
        }}{{
          !report.publicBaseURL ? "请配置支付公网 HTTPS 地址后启用渠道。" : ""
        }}
      </aside>
      <section v-if="activeModule === 'products'">
        <h2>商品与定价</h2>
        <p v-if="!productVersioning" role="status">商品版本管理等待服务更新，暂不可修改商品。</p>
        <div v-if="productVersioning" class="product-heading">
          <h3>{{productMode==='edit'?'编辑商品：'+editingProduct?.name:productMode==='copy'?'复制为新商品':'新建商品'}}<small v-if="editingProduct">当前第 {{editingProduct.versionNumber??1}} 版</small></h3>
          <button v-if="productMode!=='new'" type="button" class="secondary" :disabled="busy" @click="resetProduct">取消编辑</button>
        </div>
        <form v-if="canWrite && productVersioning" class="product-form" @submit.prevent="publish">
          <label>商品类型<select v-model="product.billingKind" :disabled="!!editingProduct"><option value="subscription">订阅套餐</option><option value="addon">算力增购包</option></select></label
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
            v-if="product.billingKind==='subscription' || !product.permanent">计费期限<select v-model="product.periodUnit"><option value="days">按天</option><option value="months">按自然月</option></select></label
          ><label v-if="product.billingKind==='addon'" class="module-option"><input v-model="product.permanent" type="checkbox" />长期有效（一次到账）</label
          ><label>商品说明<input v-model="product.description" maxlength="500" /></label
          ><label>展示排序<input v-model.number="product.sortOrder" type="number" min="0" max="1000000" required /></label
          ><label v-if="product.billingKind==='subscription'">席位数<input v-model.number="product.seatLimit" type="number" min="1" max="1000000" required /></label
          ><label v-if="product.billingKind==='subscription'">岗位数<input v-model.number="product.jobLimit" type="number" min="1" max="1000000" required /></label
          ><label v-if="(product.billingKind==='subscription' || !product.permanent) && product.periodUnit === 'days'"
            >有效天数<input
              v-model.number="product.durationDays"
              required
              type="number"
              min="1"
              max="3660" /></label
          ><label v-else-if="product.billingKind==='subscription' || !product.permanent"
            >有效月数<input v-model.number="product.durationMonths" required type="number" min="1" max="120" /></label
          ><label>AI 点数<input v-model.number="product.aiPoints" type="number" min="0" /></label
          ><label>转写分钟数<input v-model.number="product.interviewMinutes" type="number" step="any" min="0" /></label
          ><label>OCR 页数<input v-model.number="product.ocrPages" type="number" min="0" /></label
          ><label v-if="product.billingKind==='subscription'">额度发放<select v-model="product.grantPeriod"><option value="once">一次发放</option><option value="monthly">按月发放</option></select></label
          ><label v-if="product.billingKind==='subscription' && product.grantPeriod==='monthly'" class="module-option"><input v-model="product.rollover" type="checkbox" />未用额度结转至商品期限结束</label
          ><label
            >发布原因<input
              v-model="product.reason"
              required
              minlength="2"
              maxlength="500" /></label
          ><button class="primary" :disabled="busy"><Pencil v-if="editingProduct" :size="16" /><Plus v-else :size="16" />{{editingProduct?'预览修改并上架':'创建新商品'}}</button>
        </form>
        <div v-if="canWrite && productVersioning" class="product-preview" aria-label="商品展示预览">
          <h3>{{product.name || '商品预览'}}</h3>
          <strong>¥ {{product.price || '0.00'}}</strong>
          <p>{{product.billingKind==='addon' && product.permanent?'长期有效':product.periodUnit==='months'?product.durationMonths+' 个月':product.durationDays+' 天'}}<template v-if="product.billingKind==='subscription'"> · {{product.seatLimit}} 个席位 · {{product.jobLimit}} 个岗位</template></p>
          <p v-for="line in previewQuotas" :key="line">{{line}}</p>
          <p v-if="previewQuotas.length">{{product.billingKind==='addon'?'一次到账':product.grantPeriod==='monthly'?'每月发放 · '+(product.rollover?'结转至订阅到期':'当期到期失效'):'一次发放 · 订阅到期失效'}}</p>
          <p v-if="product.description">{{product.description}}</p>
        </div>
        <div v-if="canWrite && productVersioning" class="product-heading">
          <span>商品列表</span><button class="secondary" :disabled="busy || productSelection.length<2" @click="startMerge"><Merge :size="16" />归并所选商品</button>
        </div>
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
                <td><label v-if="canWrite && productVersioning" class="product-selection"><input v-model="productSelection" type="checkbox" :value="p.id" :aria-label="'选择归并 '+p.name" :disabled="busy" />{{ p.name }}</label><template v-else>{{p.name}}</template><small>第 {{p.versionNumber??1}} 版</small><small v-if="p.billingEntitlements?.quotas">{{p.billingEntitlements.quotas.ai_points}} 点 / {{formatBillingAmount(p.billingEntitlements.quotas.interview_seconds,'interview_seconds')}} 分钟 / {{p.billingEntitlements.quotas.ocr_pages}} 页 · {{p.billingEntitlements.grantPeriod==='monthly'?'每月发放':'一次发放'}}</small></td>
                <td>
                  {{ formatPayment(p.amountFen) }} / {{ paymentDurationLabel(p) }}
                </td>
                <td>{{ p.billingKind === 'addon' ? '算力增购包' : String(p.seatLimit) + ' 席位 / ' + String(p.jobLimit) + ' 岗位' }}</td>
                <td>{{ p.active ? "在售" : "已下架" }}</td>
                <td>
                  <button v-if="canWrite && productVersioning" class="secondary" :disabled="busy" @click="copyProduct(p,'edit')"><Pencil :size="16" />编辑并上架</button>
                  <button v-if="productVersioning" class="secondary" :disabled="busy || historyLoading" @click="showHistory(p)"><History :size="16" />历史版本</button>
                  <button
                    v-if="canWrite && productVersioning"
                    class="secondary"
                    :disabled="busy"
                    @click="toggle('products', p.id, !p.active)"
                  >
                    {{ p.active ? "下架" : "上架" }}
                  </button>
                  <details v-if="canWrite && productVersioning" class="product-more"><summary>更多操作</summary><button class="secondary" :disabled="busy" @click="copyProduct(p,'copy')"><Copy :size="16" />复制为新商品</button></details>
                </td>
              </tr>
              <tr v-if="!report.products.length">
                <td colspan="5">暂无商品，请先发布套餐售价。</td>
              </tr>
            </tbody>
          </table>
        </div>
        <PaymentProductDialog v-if="pendingProduct" title="确认修改并上架" :busy="busy" @close="pendingProduct=null">
          <p>将更新「{{editingProduct?.name}}」并上架第 {{(editingProduct?.versionNumber??1)+1}} 版，旧版本停止销售。历史订单及已到账权益保持不变。</p>
          <div class="table-scroll"><table class="product-diff"><thead><tr><th>修改内容</th><th>原版本</th><th>新版本</th></tr></thead><tbody><tr v-for="[label,before,after] in productDiff" :key="label"><th>{{label}}</th><td>{{before===''?'（空）':before}}</td><td>{{after===''?'（空）':after}}</td></tr></tbody></table></div>
          <p v-if="!productDiff.length">配置未变化，本次只生成新版本并重新上架。</p><p>操作原因：{{pendingProduct.reason}}</p><p v-if="error" role="alert">{{error}}</p>
          <template #actions><button class="secondary" :disabled="busy" @click="pendingProduct=null">返回编辑</button><button class="primary" :disabled="busy" @click="confirmRevision">{{busy?'正在发布…':'确认修改并上架'}}</button></template>
        </PaymentProductDialog>
        <PaymentProductDialog v-if="history" title="商品历史版本" @close="history=null">
          <div v-for="v in history.versions" :key="v.id" class="product-history-row">
            <h3>{{v.name}} · 第 {{v.versionNumber}} 版 <span v-if="v.id===history.currentVersionId">（当前版本 · {{v.active?'在售':'已下架'}}）</span></h3>
            <p>{{formatPayment(v.amountFen)}} / {{paymentDurationLabel(v)}}<template v-if="v.billingKind!=='addon'"> · {{v.seatLimit}} 席位 / {{v.jobLimit}} 岗位</template></p>
            <p v-if="v.billingEntitlements?.quotas">{{v.billingEntitlements.quotas.ai_points}} 点 / {{formatBillingAmount(v.billingEntitlements.quotas.interview_seconds,'interview_seconds')}} 分钟 / {{v.billingEntitlements.quotas.ocr_pages}} 页 · {{v.billingEntitlements.grantPeriod==='monthly'?'按月发放':'一次发放'}} · {{v.billingEntitlements.rollover?'余额结转':'不结转'}}</p>
            <p v-if="v.description">{{v.description}}</p><p>{{v.createdAt?new Date(v.createdAt).toLocaleString('zh-CN'):''}} · {{v.operatorName}} · {{v.versionReason}}</p>
            <button v-if="canWrite && v.id!==history.currentVersionId" class="secondary" @click="restoreProduct(v)">以此版本恢复</button>
          </div>
          <template #actions><button class="secondary" @click="history=null">关闭</button></template>
        </PaymentProductDialog>
        <PaymentProductDialog v-if="merging" title="归并商品" :busy="busy" @close="merging=false">
          <form id="product-merge-form" class="merge-form" @submit.prevent="confirmMerge">
            <p>所选商品将合为一条主记录，其他配置收进历史。请选择保留的当前版本；原订单和权益不变。</p>
            <label v-for="v in mergeItems" :key="v.id" class="merge-choice"><input v-model="mergeKeep" required type="radio" name="merge-keep" :value="v.id" :disabled="busy" /><span>{{v.name}} · 第 {{v.versionNumber??1}} 版 · {{formatPayment(v.amountFen)}} / {{paymentDurationLabel(v)}} · {{v.active?'在售':'已下架'}}<small v-if="v.billingEntitlements?.quotas">{{v.billingEntitlements.quotas.ai_points}} 点 / {{formatBillingAmount(v.billingEntitlements.quotas.interview_seconds,'interview_seconds')}} 分钟 / {{v.billingEntitlements.quotas.ocr_pages}} 页</small></span></label>
            <label class="module-option"><input v-model="mergeActive" type="checkbox" :disabled="busy" />归并后上架所选版本</label>
            <label>归并原因<input v-model="mergeReason" required minlength="2" maxlength="500" :disabled="busy" /></label><p v-if="error" role="alert">{{error}}</p>
          </form>
          <template #actions><button class="secondary" :disabled="busy" @click="merging=false">取消</button><button class="primary" form="product-merge-form" :disabled="busy || !mergeKeep">确认归并</button></template>
        </PaymentProductDialog>
      </section>
      <CreditConversionPanel v-if="activeModule === 'products' && canWrite" />
      <section v-if="activeModule === 'channels'">
        <h2>收款渠道</h2>
        <p>
          支持微信 API v3、支付宝 RSA2 和
          EasyPay。新配置默认停用；密钥加密存储且不回显。轮换密钥请新增渠道版本，旧订单继续使用原配置。
        </p>
        <div class="channels">
          <article v-for="p in report.providers" :key="p.id">
            <b>{{ p.name }}</b
            ><span>{{ p.kind }}{{ p.environment === "sandbox" ? " · 沙箱测试" : "" }} · {{ p.enabled ? "已启用" : "已停用" }}</span
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
            novalidate
            :aria-busy="channelSaving"
            @submit.prevent="saveChannel"
          >
            <label
              >渠道名称<input
                v-model="channel.name"
                aria-label="渠道名称"
                :disabled="channelSaving"
                required
                minlength="2"
                maxlength="80" /></label
            ><label
              >接口类型<select v-model="channel.kind" :disabled="channelSaving">
                <option value="alipay">支付宝官方</option>
                <option value="wxpay">微信支付官方</option>
                <option value="easypay">EasyPay 聚合支付</option>
              </select></label
            ><label v-if="channel.kind === 'alipay'">支付宝环境<select v-model="channel.config.environment" :disabled="channelSaving"><option value="production">正式收款</option><option value="sandbox">沙箱测试（不开通正式套餐）</option></select></label><label v-for="[key, label] in fields[channel.kind]" :key="key">
              <span class="key-label">{{ label }}<button
                v-if="secret(key)"
                type="button"
                class="key-toggle"
                :aria-label="(revealedKeys[key] ? '隐藏' : '显示') + label"
                :aria-pressed="!!revealedKeys[key]"
                :disabled="channelSaving"
                @click.prevent="revealedKeys[key] = !revealedKeys[key]"
              >{{ revealedKeys[key] ? '隐藏' : '显示' }}</button></span>
              <textarea
                v-if="multilineKey(key) && revealedKeys[key]"
                v-model="channel.config[key]"
                :aria-label="label"
                :disabled="channelSaving"
                required
                maxlength="16000"
                rows="4"
                autocomplete="off"
                spellcheck="false"
              /><input
                v-else
                v-model="channel.config[key]"
                :aria-label="label"
                :disabled="channelSaving"
                required
                maxlength="16000"
                :type="secret(key) && !revealedKeys[key] ? 'password' : 'text'"
                autocomplete="off"
                spellcheck="false"
                @paste="multilineKey(key) && pasteKey($event, key)"
              />
              <small v-if="multilineKey(key)">支持直接粘贴完整 PEM 密钥，保留换行；粘贴会替换整段内容，点击显示可编辑。</small>
            </label
            ><label
              >操作原因<input
                v-model="channel.reason"
                aria-label="操作原因"
                :disabled="channelSaving"
                required
                minlength="2"
                maxlength="500" /></label
            >
            <p v-if="!report.keyConfigured" class="alert" role="alert">服务器尚未配置支付加密主密钥，暂时无法保存收款渠道，请先完成服务器配置。</p>
            <p v-if="channelError" class="alert" role="alert" data-channel-error>{{ channelError }}</p>
            <p v-if="channelNotice" class="notice" role="status" data-channel-notice>{{ channelNotice }}</p>
            <button type="submit" class="primary" :disabled="busy || !report.keyConfigured">
              {{ channelSaving ? '正在保存…' : '加密保存渠道' }}
            </button>
          </form>
        </details>
      </section>
      <section v-if="activeModule === 'orders'">
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
                <td>{{ o.name }}<small v-if="o.environment === 'sandbox'">沙箱测试</small></td>
                <td>{{ formatPayment(o.amountFen) }}</td>
                <td>
                  {{ o.channelClosePending ? '关单待确认' : o.cancelRequestedAt && ['pending', 'uncertain'].includes(o.status) ? '取消待确认' : paymentStatusLabel[o.status]
                  }}<small v-if="o.cancellationMessage || o.reviewReason">{{ o.cancellationMessage || o.reviewReason }}</small>
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
      <AlipayBillPanel v-if="activeModule === 'reconciliation' && canWrite" :providers="report.providers" />
    </template>
    </div>
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
.module-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin-top: 24px;
  border-bottom: 1px solid #cbd9e4;
}
.module-tabs button {
  position: relative;
  flex: 0 0 auto;
  padding: 14px 4px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: #526477;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.module-tabs button:hover { color: #176bb3; background: #edf5fc; }
.module-tabs button[aria-selected="true"] { color: #125e9e; }
.module-tabs button[aria-selected="true"]::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 0;
  right: 0;
  height: 3px;
  background: #176bb3;
}
.module-tabs button:focus-visible, .module-content:focus-visible { outline: 2px solid #176bb3; outline-offset: 3px; }
.module-content { min-width: 0; }
.module-content > section:first-child { border-top: 0; margin-top: 0; }
.service-request, section[aria-label="重复待支付订单"] article { border: 1px solid #d6e1e9; border-radius: 6px; padding: 16px; margin: 12px 0; background: #fff; overflow-wrap: anywhere; }
.eyebrow {
  font-size: 12px;
  letter-spacing: 0;
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
  border-top: 1px solid #dce5ec;
  padding: 24px 0;
  margin-top: 24px;
}
.product-preview{border-block:1px solid #d9e4e9;padding:16px 0;margin:16px 0;overflow-wrap:anywhere}.product-preview h3{font-size:17px;margin:0 0 10px}.product-preview p{margin:5px 0;font-size:13px}.product-preview strong{font-size:24px;color:#28765e}
.product-form {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin: 20px 0;
}
.product-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:20px}.product-heading h3{font-size:16px;margin:0}.product-selection,.merge-choice{display:flex;align-items:center;gap:8px}.product-more{display:inline-block;vertical-align:top}.product-more summary{cursor:pointer;padding:10px;color:#27618f}.product-more button{margin-top:6px}.primary svg,.secondary svg{vertical-align:middle;margin-right:5px}.product-diff{min-width:0;table-layout:fixed}.product-diff td,.product-diff th{overflow-wrap:anywhere;white-space:normal}.product-history-row{border-bottom:1px solid #dce5ec;padding:0 0 16px;margin-bottom:16px}.product-history-row h3{font-size:16px}.product-history-row p{font-size:14px}.merge-form{display:grid;gap:16px}.merge-choice{align-items:flex-start;line-height:1.6}
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
.key-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.key-toggle {
  background: transparent;
  border: 0;
  color: #176bb3;
  cursor: pointer;
  font: inherit;
  padding: 4px 8px;
}
.channel-form input, .channel-form textarea, .channel-form select { min-width: 0; width: 100%; box-sizing: border-box; }
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
  min-width: 680px;
  border-collapse: collapse;
  text-align: left;
}
th,
td {
  vertical-align: top;
  font-size: 14px;
  padding: 13px 10px;
  border-bottom: 1px solid #edf0f5;
}
td button { white-space: nowrap; margin: 0 6px 6px 0; }
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
  border-radius: 8px;
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
  .module-tabs { gap: 0 12px; margin-top: 16px; }
  .module-tabs button { padding: 12px 2px; font-size: 13px; }
}
</style>
