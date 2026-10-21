<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ApiClientError } from '../../../shared/api/errors'
import { getBillingSandbox,createSandboxOrder,simulateSandboxOrder,type SandboxReport,type SandboxOrder } from '../api/billing-sandbox'
const report=ref<SandboxReport|null>(null),busy=ref(false),error=ref(''),notice=ref(''),page=ref(1)
const channel=ref<SandboxOrder['channel']>('mock_alipay'),refundOrder=ref<string|null>(null),reason=ref('')
// Preserve a create key across uncertain network outcomes; explicit new orders get new keys.
const pendingCreate=ref<{productCode:string;channel:SandboxOrder['channel'];version:number;key:string}|null>(null)
const labels:Record<SandboxOrder['status'],string>={pending:'待模拟支付',failed:'模拟支付失败',fulfilled:'模拟支付成功',review:'待人工核对（未发放）',refunded:'已模拟退款',expired:'已超时',cancelled:'已取消'}
const money=(fen:number)=>(fen/100).toFixed(2)
const date=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN'):'—'
async function load(target=page.value) {if(busy.value)return;busy.value=true;error.value='';try{report.value=await getBillingSandbox(target);page.value=target}catch(e){report.value=null;error.value=e instanceof Error?e.message:'读取模拟订单失败'}finally{busy.value=false}}
async function create(productCode:string) {
 if(busy.value||!report.value)return
 if(pendingCreate.value && pendingCreate.value.productCode!==productCode){error.value='请先重试上次创建，确认订单结果后再选择其他商品';return}
 pendingCreate.value??={productCode,channel:channel.value,version:report.value.entitlement.version,key:crypto.randomUUID()}
 busy.value=true;error.value='';notice.value=''
 try {const p=pendingCreate.value;const order=await createSandboxOrder(p.productCode,p.channel,p.version,p.key);pendingCreate.value=null;notice.value='已创建模拟订单 '+order.id;report.value=await getBillingSandbox(1);page.value=1}
 catch(e){if(e instanceof ApiClientError && e.status && e.status>=400 && e.status<500)pendingCreate.value=null;error.value=e instanceof Error?e.message:'创建失败，请重试确认订单';report.value=null}
 finally{busy.value=false}
}
async function action(order:SandboxOrder,kind:'success'|'failure'|'refund'|'expire'|'cancel') {
 if(busy.value)return
 if(kind==='refund' && reason.value.trim().length<2){error.value='请填写至少 2 字的模拟退款原因';return}
 busy.value=true;error.value='';notice.value=''
 try {const result=await simulateSandboxOrder(order.id,kind,reason.value);notice.value=result.replayed?'重复通知已识别，未重复发放权益':result.outcome==='review'?'模拟款项已记录，订单待核对，未发放权益':'模拟操作已完成';refundOrder.value=null;reason.value='';report.value=await getBillingSandbox(page.value)}
 catch(e){error.value=e instanceof Error?e.message:'模拟操作失败';report.value=null}
 finally{busy.value=false}
}
onMounted(()=>load())
</script>
<template>
 <main class="sandbox-page">
  <header><div><span class="tag">模拟测试</span><h1>订单与支付测试</h1><p>测试金额不代表正式售价。当前不接真实支付宝或微信，不会收款。</p></div><button :disabled="busy" @click="load()">{{busy?'处理中…':'刷新订单'}}</button></header>
  <aside class="scope">模拟权益仅用于验证订单流程，不改变当前企业的真实套餐、成员席位、岗位配额或服务状态。支付宝与微信选项仅模拟支付场景。</aside>
  <p v-if="error" role="alert" class="error">{{error}}</p><p v-if="notice" role="status" class="notice">{{notice}}</p>
  <template v-if="report">
   <section class="shadow"><h2>当前模拟权益</h2><p>{{report.entitlement.effective?report.entitlement.name:'暂无生效的模拟权益'}} · 版本 {{report.entitlement.version}}</p><p v-if="report.entitlement.effective">{{report.entitlement.seatLimit}} 席位 / {{report.entitlement.jobLimit}} 岗位 · 到期 {{date(report.entitlement.expiresAt)}}</p></section>
   <section><h2>创建模拟订单</h2><label>模拟渠道 <select v-model="channel" :disabled="busy||!!pendingCreate"><option value="mock_alipay">支付宝场景（模拟）</option><option value="mock_wechat">微信场景（模拟）</option></select></label>
    <div class="products"><article v-for="product in report.catalog" :key="product.code"><h3>{{product.name}}</h3><strong>测试金额 ¥{{money(product.amountFen)}}</strong><p>{{product.seatLimit}} 席位 · {{product.jobLimit}} 岗位 · {{product.durationDays}} 天</p><button :disabled="busy || (!!pendingCreate && pendingCreate.productCode!==product.code)" @click="create(product.code)">{{pendingCreate?.productCode===product.code?'重试确认上次订单':'创建模拟订单'}}</button></article></div>
   </section>
   <section><h2>模拟订单记录</h2><p v-if="!report.orders.length">暂无模拟订单</p><div v-else class="orders">
    <article v-for="order in report.orders" :key="order.id"><div class="order-heading"><h3>{{order.name}}</h3><span>{{labels[order.status]}}</span></div><p class="order-id">订单 {{order.id}}</p><p>测试金额 ¥{{money(order.amountFen)}} · {{order.channel==='mock_alipay'?'支付宝场景（模拟）':'微信场景（模拟）'}} · {{date(order.createdAt)}}</p>
     <p v-if="order.status==='review'" class="warning">超时、已取消或权益版本冲突的模拟通知需要核对。可模拟退款；不会自动覆盖权益。</p>
     <div class="actions"><button v-if="['pending','failed'].includes(order.status)" :disabled="busy" @click="action(order,'success')">模拟支付成功</button><button v-if="order.status==='pending'" :disabled="busy" @click="action(order,'failure')">模拟支付失败</button><button v-if="['pending','failed'].includes(order.status)" :disabled="busy" @click="action(order,'cancel')">取消模拟订单</button><button v-if="['pending','failed'].includes(order.status) && new Date(order.expiresAt).getTime() <= Date.now()" :disabled="busy" @click="action(order,'expire')">确认订单超时</button><button v-if="['fulfilled','review','refunded'].includes(order.status)" :disabled="busy" @click="action(order,'success')">重发成功通知</button><button v-if="['fulfilled','review'].includes(order.status)" :disabled="busy" @click="refundOrder=order.id;reason=''">模拟全额退款</button></div>
     <form v-if="refundOrder===order.id" @submit.prevent="action(order,'refund')"><label>模拟退款原因 <input v-model="reason" maxlength="300" placeholder="例如：测试退款流程" :disabled="busy" /></label><button :disabled="busy||reason.trim().length<2">确认模拟退款</button><button type="button" :disabled="busy" @click="refundOrder=null">返回</button></form>
    </article></div>
    <footer><button :disabled="busy||page<=1" @click="load(page-1)">上一页</button><span>第 {{page}} 页 · {{report.total}} 条</span><button :disabled="busy||page*report.pageSize>=report.total" @click="load(page+1)">下一页</button></footer>
   </section>
  </template>
 </main>
</template>
<style scoped>
.sandbox-page{display:grid;gap:20px;max-width:1140px;margin:0 auto;color:#244a50}header,.order-heading{display:flex;justify-content:space-between;align-items:center;gap:16px}h1{font-size:26px;margin:10px 0}h2{font-size:18px}h3{font-size:16px;margin:5px 0}p{line-height:1.6;font-size:14px}section,.orders article{padding:20px;background:rgba(255,255,255,.75);border:1px solid #d5e8e4;border-radius:16px}.shadow{background:linear-gradient(120deg,#e7f4ee,#e7effb)}.tag{background:#e7edf9;color:#4b638e;border-radius:7px;padding:5px 10px;font-size:12px}.scope,.warning{padding:16px;border-radius:12px;background:#fff4df;color:#7b602f;font-size:14px;line-height:1.7}.products{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:18px}.products article{padding:20px;border-radius:12px;background:linear-gradient(125deg,#eef8f2,#edf3ff)}button,select,input{padding:10px 14px;border:1px solid #a4c9c0;border-radius:8px;background:#f2faf7;color:#295e52;font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}.actions,form{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.orders{display:grid;gap:14px}.order-id{overflow-wrap:anywhere;color:#6f8389;font-size:12px}footer{display:flex;gap:14px;align-items:center;justify-content:flex-end;margin-top:20px}.error,.notice{padding:15px;border-radius:12px}.error{background:#ffeded;color:#a33f47}.notice{background:#e7f6ee;color:#266844}@media(max-width:600px){header,.order-heading{align-items:flex-start;flex-direction:column}section{padding:14px}form label,input{max-width:100%}}
</style>
