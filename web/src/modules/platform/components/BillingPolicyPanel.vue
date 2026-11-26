<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { getBillingPolicy, publishBillingPolicy, resolveBillingTask, type BillingOverview, type BillingOperation } from '../api/payments';
import { billingResourceLabels, formatBillingAmount } from '../utils/billingUnits';
import { describeApiFailure } from '../../../shared/utils/errorMessage';
const state=ref<BillingOverview|null>(null),reason=ref(''),busy=ref(false),error=ref(''),notice=ref('');
const labels:Record<BillingOperation,string>={resume_analysis:'简历分析',job_spec:'岗位说明生成',jd:'职位描述生成',interview_questions:'面试题生成',answer_analysis:'回答分析',interview_summary:'面试总结',transcript_processing:'转写后处理',interview_audio:'音频转写',ocr:'简历 OCR'};
const resources=billingResourceLabels;
const reconciliation=reactive({id:'',state:'released' as 'settled'|'released',reason:''});
async function load(){try{state.value=await getBillingPolicy()}catch(e){error.value=describeApiFailure(e,'读取执行规则失败').message}}
async function run(action:()=>Promise<unknown>,success:string){if(busy.value)return;busy.value=true;error.value='';notice.value='';try{await action();notice.value=success;await load()}catch(e){error.value=describeApiFailure(e,'保存失败').message}finally{busy.value=false}}
async function save(){if(!state.value||reason.value.trim().length<2)return;await run(async()=>{await publishBillingPolicy({config:{...state.value!.config,enabled:false},expectedVersion:state.value!.version,reason:reason.value.trim()});reason.value=''},'执行规则已发布')}
async function resolve(){await run(async()=>{await resolveBillingTask(reconciliation.id,{state:reconciliation.state,reason:reconciliation.reason});reconciliation.id='';reconciliation.reason=''},'历史任务已核对')}
onMounted(()=>void load());
</script>
<template>
<section aria-label="企业执行规则">
  <h2>执行与服务试用规则</h2>
  <p v-if="error" role="alert" class="error">{{error}}</p><p v-if="notice" role="status" class="notice">{{notice}}</p>
  <template v-if="state">
    <form @submit.prevent="save"><fieldset :disabled="busy">
      <p>当前规则版本 {{state.version}}</p>
      <h3>企业执行上限</h3><div class="grid"><label>最大并发<input v-model.number="state.config.limits.maxConcurrent" type="number" required min="1" max="1000"></label><label>单次输入字符<input v-model.number="state.config.limits.maxInputChars" type="number" required min="1" max="2000000"></label><label>单次输出 Token<input v-model.number="state.config.limits.maxOutputTokens" type="number" required min="1" max="100000"></label></div>
      <h3>新企业试用设置</h3><div class="grid"><label>试用天数<input v-model.number="state.config.trial.durationDays" type="number" required step="1" min="1" max="3660"></label><label>试用席位数<input v-model.number="state.config.trial.seatLimit" type="number" required step="1" min="1" max="1000000"></label><label>试用岗位数<input v-model.number="state.config.trial.jobLimit" type="number" required step="1" min="1" max="1000000"></label></div><p class="hint">新企业按创建时的设置开通试用；已有企业的期限和容量可在企业管理中调整。</p>
      <div class="save-row"><label>发布原因<input v-model="reason" required minlength="2" maxlength="500"></label><button class="primary" :disabled="busy">发布新规则</button></div>
    </fieldset></form>
    <details><summary>规则发布记录</summary><div class="table-wrap"><table><thead><tr><th>版本</th><th>发布时间</th><th>原因</th></tr></thead><tbody><tr v-for="item in state.history" :key="item.version"><td>{{item.version}}</td><td>{{new Date(item.created_at).toLocaleString('zh-CN')}}</td><td>{{item.reason}}</td></tr></tbody></table></div></details>
    <details aria-label="历史计费任务核对"><summary>历史计费任务核对</summary>
    <p v-if="!state.tasks?.length">暂无需要核对的任务。</p>
    <div v-else class="table-wrap"><table><thead><tr><th>企业 / 业务</th><th>历史预占额度</th><th>状态 / 时间</th><th>操作</th></tr></thead><tbody><tr v-for="item in state.tasks" :key="item.id"><td>{{item.organizationName}}<br>{{labels[item.operation]}}</td><td>{{formatBillingAmount(item.units,item.resource)}} {{resources[item.resource]}}</td><td>{{item.state==='uncertain'?'结果待核对':'处理超时'}}<br>{{new Date(item.createdAt!).toLocaleString('zh-CN')}}</td><td><button class="secondary" @click="reconciliation.id=item.id">核对</button></td></tr></tbody></table></div>
    <form v-if="reconciliation.id" class="save-row" @submit.prevent="resolve"><label>任务<input :value="reconciliation.id" readonly></label><label>核对结果<select v-model="reconciliation.state"><option value="released">确认未完成，退回额度</option><option value="settled">确认已完成，结算额度</option></select></label><label>核对依据<input v-model.trim="reconciliation.reason" required minlength="2" maxlength="500"></label><button class="primary" :disabled="busy">保存核对结果</button><button type="button" class="secondary" @click="reconciliation.id=''">取消</button></form>
    </details>
  </template>
</section>
</template>
<style scoped>
section{border-top:1px solid #e3eaf2;padding:24px 0;margin-top:24px;color:#183049;min-width:0}fieldset{border:0;margin:0;padding:0;min-width:0}h2{margin:0 0 14px}h3{margin:22px 0 12px;font-size:16px}.toggle{display:flex;align-items:center;gap:8px}.table-wrap{overflow:auto}.table-wrap table{min-width:720px}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{white-space:nowrap;text-align:left;padding:10px;border-bottom:1px solid #edf0f5}td input[type=number]{width:105px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.grid label,.save-row label{display:grid;gap:7px;min-width:0}.save-row{display:flex;align-items:end;gap:12px;margin-top:18px;flex-wrap:wrap}.save-row label{flex:1;min-width:140px}input,select{padding:8px;border:1px solid #ced9e6;border-radius:6px;font:inherit;min-width:0;max-width:100%;box-sizing:border-box}button{padding:10px 14px;border-radius:6px;font:inherit;cursor:pointer}.primary{background:#176bb3;color:white;border:1px solid #176bb3}.secondary{background:white;color:#176bb3;border:1px solid #b8cce1}.error{color:#a82a2a}.notice{color:#217546}.hint{color:#5d6f82;line-height:1.6}.grant-form{align-items:end}.customer-search{display:flex;align-items:end;gap:12px;margin-bottom:12px}.customer-search label{display:grid;gap:7px;flex:1;max-width:420px;min-width:0}details{margin-top:20px}button:disabled{opacity:.5;cursor:wait}@media(max-width:760px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.save-row{align-items:stretch;flex-direction:column}}@media(max-width:420px){.grid{grid-template-columns:minmax(0,1fr)}}
</style>
