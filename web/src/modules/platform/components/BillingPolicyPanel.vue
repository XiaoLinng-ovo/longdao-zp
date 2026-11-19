<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import { listCustomers, type PlatformCustomer } from '../api';
import { getBillingPolicy, publishBillingPolicy, grantBillingQuota, resolveBillingTask, type BillingOverview, type BillingOperation, type BillingResource } from '../api/payments';
import { billingResourceLabels, billingPolicyInMinutes, billingPolicyInSeconds, toBillingStorage, formatBillingAmount } from '../utils/billingUnits';
import { describeApiFailure } from '../../../shared/utils/errorMessage';
const state=ref<BillingOverview|null>(null),reason=ref(''),busy=ref(false),error=ref(''),notice=ref('');
const labels:Record<BillingOperation,string>={resume_analysis:'简历分析',job_spec:'岗位说明生成',jd:'职位描述生成',interview_questions:'面试题生成（每组）',answer_analysis:'回答与阶段分析',interview_summary:'面试总结',transcript_processing:'转写后处理',interview_audio:'面试音频转写',ocr:'简历 OCR'};
const resources=billingResourceLabels;
const unit=(key:string)=>key==='interview_audio'?'分钟':key==='ocr'?'页':'次';
const grant=reactive({organizationId:'',resource:'ai_points' as BillingResource,units:0,expiresAt:'',reason:''});
const permanentGrant=ref(false);
const reconciliation=reactive({id:'',state:'released' as 'settled'|'released',reason:''});
let pendingGrant:{key:string;fingerprint:string}|undefined;
const customerQuery=ref(''),customers=ref<PlatformCustomer[]>([]),customerBusy=ref(false),customerError=ref('');
let customerSearch=0;
watch(customerQuery,()=>{customerSearch++;customers.value=[];grant.organizationId='';customerError.value='';customerBusy.value=false});
async function searchCustomers(){const request=++customerSearch;customerBusy.value=true;customerError.value='';customers.value=[];grant.organizationId='';try{const result=await listCustomers(customerQuery.value.trim());if(request!==customerSearch)return;customers.value=result.items;if(!result.items.length)customerError.value='未找到匹配的企业，请调整名称或企业 ID'}catch(e){if(request===customerSearch)customerError.value=describeApiFailure(e,'查找企业失败，请重试').message}finally{if(request===customerSearch)customerBusy.value=false}}

async function load(){try{const result=await getBillingPolicy();state.value={...result,config:billingPolicyInMinutes(result.config)}}catch(e){error.value=describeApiFailure(e,'读取算力规则失败').message}}
async function run(action:()=>Promise<unknown>,success:string){if(busy.value)return;busy.value=true;error.value='';notice.value='';try{await action();notice.value=success;await load()}catch(e){error.value=describeApiFailure(e,'保存失败').message}finally{busy.value=false}}
async function save(){if(!state.value||reason.value.trim().length<2)return;await run(async()=>{const input={config:billingPolicyInSeconds(state.value!.config),expectedVersion:state.value!.version,reason:reason.value.trim()};await publishBillingPolicy(input);reason.value=''},'新规则已发布，用于后续新任务；进行中的面试保持原规则')}
async function submitGrant(){if(!customers.value.some(item=>item.id===grant.organizationId)){error.value='请先查找并选择需要发放额度的企业';return}const expiry=new Date(grant.expiresAt);if(!permanentGrant.value&&(!Number.isFinite(expiry.getTime())||expiry.getTime()<=Date.now())){error.value='请选择有效的未来到期时间';return}await run(async()=>{const input={...grant,units:toBillingStorage(grant.units,grant.resource),expiresAt:permanentGrant.value?null:expiry.toISOString()};const fingerprint=JSON.stringify(input);if(!pendingGrant||pendingGrant.fingerprint!==fingerprint)pendingGrant={key:crypto.randomUUID(),fingerprint};await grantBillingQuota({...input,key:pendingGrant.key});pendingGrant=undefined;grant.reason=''},'企业额度已发放')}
async function resolve(){await run(async()=>{await resolveBillingTask(reconciliation.id,{state:reconciliation.state,reason:reconciliation.reason});reconciliation.id='';reconciliation.reason=''},'计费任务已核对并记录')}
onMounted(()=>{void load();void searchCustomers()});
</script>
<template>
<section aria-label="算力计费规则">
  <h2>算力与试用规则</h2>
  <p v-if="error" role="alert" class="error">{{error}}</p><p v-if="notice" role="status" class="notice">{{notice}}</p>
  <template v-if="state">
    <form @submit.prevent="save"><fieldset :disabled="busy">
      <label class="toggle"><input v-model="state.config.enabled" type="checkbox">启用额度扣减</label>
      <p>当前规则版本 {{state.version}}</p>
      <div class="table-wrap"><table><thead><tr><th>业务</th><th>计费</th><th>扣除额度</th><th>每单位扣除数量</th><th>每多少业务量为一单位</th></tr></thead><tbody>
        <tr v-for="(rule,key) in state.config.rules" :key="key"><td>{{labels[key as BillingOperation]}}</td><td><input v-model="rule.enabled" type="checkbox" :aria-label="labels[key as BillingOperation]+'计费开关'"></td><td><select v-model="rule.resource" :aria-label="labels[key as BillingOperation]+'额度类型'"><option v-for="(label,value) in resources" :key="value" :value="value">{{label}}</option></select></td><td><input v-model.number="rule.quantity" type="number" required :step="rule.resource==='interview_seconds'?'any':1" min="0" :max="rule.resource==='interview_seconds'?1000000000/60:1000000000" :aria-label="labels[key as BillingOperation]+'扣除数量'"></td><td><input v-model.number="rule.unitSize" type="number" required :step="key==='interview_audio'?'any':1" :min="key==='interview_audio'?1/60:1" :max="key==='interview_audio'?1000000000/60:1000000000" :aria-label="labels[key as BillingOperation]+'单位大小'"> {{unit(key)}}</td></tr>
      </tbody></table></div>
      <p class="hint">按业务量除以单位大小向上取整后扣除。转写按同一场面试的覆盖时长合并计量，默认累计不足一分钟按一分钟扣除；默认总结和后处理可设为不单独扣费。</p>
      <h3>企业成本保护上限</h3><div class="grid"><label>最大并发<input v-model.number="state.config.limits.maxConcurrent" type="number" required step="1" min="1" max="1000"></label><label>每日 AI 点数<input v-model.number="state.config.limits.dailyAiPoints" type="number" required step="1" min="1"></label><label>单次输入字符<input v-model.number="state.config.limits.maxInputChars" type="number" required step="1" min="1"></label><label>单次输出 Token<input v-model.number="state.config.limits.maxOutputTokens" type="number" required step="1" min="1"></label></div>
      <h3>新企业试用设置</h3><div class="grid"><label>试用天数<input v-model.number="state.config.trial.durationDays" type="number" required step="1" min="1" max="3660"></label><label>试用席位数<input v-model.number="state.config.trial.seatLimit" type="number" required step="1" min="1" max="1000000"></label><label>试用岗位数<input v-model.number="state.config.trial.jobLimit" type="number" required step="1" min="1" max="1000000"></label></div><p class="hint">新企业按创建时的设置开通试用；已有企业的期限和容量可在企业管理中调整。</p>
      <h3>试用额度</h3><div class="grid"><label>简历上传数<input v-model.number="state.config.trial.resumeUploads" type="number" required step="1" min="0"></label><label>面试数<input v-model.number="state.config.trial.interviews" type="number" required step="1" min="0"></label><label>AI 生成数<input v-model.number="state.config.trial.aiGenerations" type="number" required step="1" min="0"></label></div>
      <h3>每家企业首次试用的算力额度</h3><div class="grid"><label>试用 AI 点数<input v-model.number="state.config.trial.aiPoints" type="number" required step="1" min="0"></label><label>试用转写分钟数<input v-model.number="state.config.trial.interviewSeconds" type="number" required step="any" min="0"></label><label>试用 OCR 页数<input v-model.number="state.config.trial.ocrPages" type="number" required step="1" min="0"></label></div><p class="hint">试用次数按当前配置限制；已发放的试用算力额度保持原记录，补额请使用下方额度发放。</p>
      <div class="save-row"><label>发布原因<input v-model="reason" required minlength="2" maxlength="500"></label><button class="primary" :disabled="busy">发布新规则</button></div>
    </fieldset></form>
    <details><summary>规则发布记录</summary><div class="table-wrap"><table><thead><tr><th>版本</th><th>发布时间</th><th>原因</th></tr></thead><tbody><tr v-for="item in state.history" :key="item.version"><td>{{item.version}}</td><td>{{new Date(item.created_at).toLocaleString('zh-CN')}}</td><td>{{item.reason}}</td></tr></tbody></table></div></details>
    <h3>手工发放企业额度</h3>
    <div class="customer-search"><label>企业名称或 ID<input v-model="customerQuery" :disabled="busy" placeholder="输入企业名称或企业 ID" @keydown.enter.prevent="searchCustomers"></label><button type="button" class="secondary" :disabled="busy||customerBusy" @click="searchCustomers">{{customerBusy?'查找中…':'查找企业'}}</button></div>
    <p v-if="customerError" role="status" class="error">{{customerError}}</p>
    <label class="toggle"><input v-model="permanentGrant" type="checkbox" :disabled="busy">长期有效额度</label>
    <form class="grid grant-form" @submit.prevent="submitGrant">
      <label>发放企业<select v-model="grant.organizationId" required :disabled="busy||customerBusy"><option disabled value="">请选择企业</option><option v-for="item in customers" :key="item.id" :value="item.id">{{item.name}}（{{item.id}}）</option></select></label>
      <label>额度类型<select v-model="grant.resource"><option v-for="(label,value) in resources" :key="value" :value="value">{{label}}</option></select></label>
      <label>发放数量（{{grant.resource==='interview_seconds'?'分钟':grant.resource==='ocr_pages'?'页':'点'}}）<input v-model.number="grant.units" type="number" required :step="grant.resource==='interview_seconds'?'any':1" :min="grant.resource==='interview_seconds'?1/60:1" :max="grant.resource==='interview_seconds'?1000000000000/60:1000000000000"></label>
      <label>到期时间<input v-model="grant.expiresAt" type="datetime-local" :required="!permanentGrant" :disabled="permanentGrant"></label>
      <label>发放原因<input v-model.trim="grant.reason" required minlength="2" maxlength="500"></label><button class="primary" :disabled="busy">发放额度</button>
    </form>
    <h3>待核对计费任务</h3>
    <p v-if="!state.tasks?.length">暂无需要核对的任务。</p>
    <div v-else class="table-wrap"><table><thead><tr><th>企业 / 业务</th><th>预占额度</th><th>状态 / 时间</th><th>操作</th></tr></thead><tbody><tr v-for="item in state.tasks" :key="item.id"><td>{{item.organizationName}}<br>{{labels[item.operation]}}</td><td>{{formatBillingAmount(item.units,item.resource)}} {{resources[item.resource]}}</td><td>{{item.state==='uncertain'?'结果待核对':'处理超时'}}<br>{{new Date(item.createdAt!).toLocaleString('zh-CN')}}</td><td><button class="secondary" @click="reconciliation.id=item.id">核对</button></td></tr></tbody></table></div>
    <form v-if="reconciliation.id" class="save-row" @submit.prevent="resolve"><label>任务<input :value="reconciliation.id" readonly></label><label>核对结果<select v-model="reconciliation.state"><option value="released">确认未完成，退回额度</option><option value="settled">确认已完成，结算额度</option></select></label><label>核对依据<input v-model.trim="reconciliation.reason" required minlength="2" maxlength="500"></label><button class="primary" :disabled="busy">保存核对结果</button><button type="button" class="secondary" @click="reconciliation.id=''">取消</button></form>
  </template>
</section>
</template>
<style scoped>
section{border-top:1px solid #e3eaf2;padding:24px 0;margin-top:24px;color:#183049;min-width:0}fieldset{border:0;margin:0;padding:0;min-width:0}h2{margin:0 0 14px}h3{margin:22px 0 12px;font-size:16px}.toggle{display:flex;align-items:center;gap:8px}.table-wrap{overflow:auto}.table-wrap table{min-width:720px}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{white-space:nowrap;text-align:left;padding:10px;border-bottom:1px solid #edf0f5}td input[type=number]{width:105px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.grid label,.save-row label{display:grid;gap:7px;min-width:0}.save-row{display:flex;align-items:end;gap:12px;margin-top:18px;flex-wrap:wrap}.save-row label{flex:1;min-width:140px}input,select{padding:8px;border:1px solid #ced9e6;border-radius:6px;font:inherit;min-width:0;max-width:100%;box-sizing:border-box}button{padding:10px 14px;border-radius:6px;font:inherit;cursor:pointer}.primary{background:#176bb3;color:white;border:1px solid #176bb3}.secondary{background:white;color:#176bb3;border:1px solid #b8cce1}.error{color:#a82a2a}.notice{color:#217546}.hint{color:#5d6f82;line-height:1.6}.grant-form{align-items:end}.customer-search{display:flex;align-items:end;gap:12px;margin-bottom:12px}.customer-search label{display:grid;gap:7px;flex:1;max-width:420px;min-width:0}details{margin-top:20px}button:disabled{opacity:.5;cursor:wait}@media(max-width:760px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.save-row{align-items:stretch;flex-direction:column}}@media(max-width:420px){.grid{grid-template-columns:minmax(0,1fr)}}
</style>
