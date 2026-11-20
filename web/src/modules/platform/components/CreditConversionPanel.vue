<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { previewCreditConversion, convertCredits, type CreditConversion } from '../api/payments';
import { billingResourceLabels, formatBillingAmount } from '../utils/billingUnits';
import { describeApiFailure } from '../../../shared/utils/errorMessage';
const orderId=ref(''), reason=ref(''), report=ref<CreditConversion|null>(null), busy=ref(false), error=ref(''), notice=ref('');
const eligible=computed(()=>report.value?.grants.filter(g=>!g.blockedReason).length ?? 0);
watch(orderId,()=>{report.value=null;error.value='';notice.value=''});
async function preview(){if(busy.value)return;busy.value=true;report.value=null;error.value='';notice.value='';const id=orderId.value.trim();try{const data=await previewCreditConversion(id);if(id===orderId.value.trim())report.value=data}catch(e){error.value=describeApiFailure(e,'读取历史额度失败').message}finally{busy.value=false}}
async function convert(){if(!report.value||busy.value||!eligible.value)return;if(!window.confirm('仅将预览中可转换的剩余额度改为长期有效，不补发已消耗的额度。确认转换？'))return;busy.value=true;error.value='';try{const result=await convertCredits({orderId:report.value.orderId,expectedDigest:report.value.digest,reason:reason.value});notice.value=`已转换 ${result.converted} 个额度批次`;report.value=null;reason.value=''}catch(e){error.value=describeApiFailure(e,'转换失败，请重新预览').message;report.value=null}finally{busy.value=false}}
</script>
<template>
  <section class="conversion" aria-label="历史付费额度转换">
    <h3>历史付费额度转换</h3>
    <form @submit.prevent="preview"><label>增购订单 ID<input v-model.trim="orderId" required :disabled="busy" /></label><button :disabled="busy">预览剩余额度</button></form>
    <p v-if="error" role="alert">{{error}}</p><p v-if="notice" role="status">{{notice}}</p>
    <template v-if="report"><div class="table-scroll"><table><thead><tr><th>额度</th><th>剩余</th><th>原到期时间</th><th>处理结果</th></tr></thead><tbody><tr v-for="g in report.grants" :key="g.id"><td>{{billingResourceLabels[g.resource]}}</td><td>{{formatBillingAmount(g.remaining,g.resource)}}</td><td>{{g.expires_at?new Date(g.expires_at).toLocaleString('zh-CN'):'长期有效'}}</td><td>{{g.blockedReason ?? '可转换为长期有效'}}</td></tr></tbody></table></div><p v-if="!report.grants.length">该订单没有额度批次</p><form v-if="eligible" @submit.prevent="convert"><label>转换原因<input v-model.trim="reason" required minlength="2" maxlength="500" :disabled="busy" /></label><button :disabled="busy">确认转换 {{eligible}} 个批次</button></form></template>
  </section>
</template>
<style scoped>
.conversion{margin-top:24px;border-top:1px solid #dce5ec;padding-top:16px}h3{font-size:16px}form{display:flex;gap:12px;align-items:end;flex-wrap:wrap}label{display:grid;gap:8px;flex:1;min-width:180px;max-width:480px}input,button{font:inherit;padding:10px;border:1px solid #bdccd5;border-radius:6px}button{background:#176d65;color:white;cursor:pointer}button:disabled{opacity:.5}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:560px}td,th{text-align:left;padding:12px;border-bottom:1px solid #dce5ec}
</style>
