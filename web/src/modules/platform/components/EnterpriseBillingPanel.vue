<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { getEnterpriseBilling, type EnterpriseBilling, type BillingOperation, type BillingResource } from '../api/payments';
import { authSession } from '../../auth/session';
import { billingResourceLabels, formatBillingAmount } from '../utils/billingUnits';
import { describeApiFailure } from '../../../shared/utils/errorMessage';
import { formatBusinessDateTime } from '../../../shared/utils/date-time';
const report=ref<EnterpriseBilling|null>(null),busy=ref(false),error=ref('');
const resources=billingResourceLabels;
const operations:Record<BillingOperation,string>={resume_analysis:'简历分析',job_spec:'岗位说明生成',jd:'职位描述生成',interview_questions:'面试题生成',answer_analysis:'回答与阶段分析',interview_summary:'面试总结',transcript_processing:'转写后处理',interview_audio:'面试音频转写',ocr:'简历 OCR'};
const states={reserved:'处理中（已预占）',settled:'已扣除',released:'已退回',uncertain:'待平台核对'};
const keys=Object.keys(resources) as BillingResource[];
const scope=computed(()=>[authSession.user?.workspaceId,authSession.user?.id,authSession.sessionId].join(':'));
let version=0,alive=true;
const date=(value:string|null|undefined)=>value?formatBusinessDateTime(value):'—';
const sources:Record<string,string>={paid_addon:'付费充值',subscription:'订阅附带',trial:'试用额度',manual:'人工发放'};
const balance=(key:BillingResource)=>report.value?.resources.find(item=>item.resource===key);
async function load(){const org=authSession.user?.workspaceId,stamp=++version;report.value=null;error.value='';busy.value=!!org;if(!org)return;try{const result=await getEnterpriseBilling(org);if(alive && stamp===version)report.value=result}catch(e){if(alive && stamp===version)error.value=describeApiFailure(e,'读取企业额度失败').message}finally{if(alive && stamp===version)busy.value=false}}
watch(scope,()=>void load(),{immediate:true});onBeforeUnmount(()=>{alive=false;version++});
</script>
<template>
<section class="billing-panel" aria-label="企业共享额度">
  <header><div><h2>企业共享额度</h2><p>企业内所有成员共同使用，由平台统一提供模型服务。</p></div><button :disabled="busy" @click="load">{{busy?'读取中…':'刷新额度'}}</button></header>
  <p v-if="error" class="error" role="alert">{{error}}</p>
  <template v-if="report">
    <details v-if="report.execution?.enabled" aria-label="执行通道"><summary>执行通道</summary><div class="table-scroll"><table><thead><tr><th>通道</th><th>正在执行</th><th>并发上限</th><th>交互保留位</th></tr></thead><tbody><tr><td>对话与后台生成</td><td>{{report.execution.text.active}}</td><td>{{report.execution.text.limit}}</td><td>{{report.execution.text.reservedInteractive}}</td></tr><tr><td>录音转写</td><td>{{report.execution.audio.active}}</td><td>{{report.execution.audio.limit}}</td><td>—</td></tr><tr><td>实时转写会话</td><td>{{report.execution.realtime.active}}</td><td>{{report.execution.realtime.limit}}</td><td>—</td></tr></tbody></table></div></details>
    <p v-if="!report.enabled" class="hint">平台暂未启用额度扣减。</p>
    <p v-if="report.serviceAvailable===false" class="hint">企业服务暂停期间，付费余额保留；续费后可继续使用。</p>
    <div class="balances"><div v-for="key in keys" :key="key"><span>{{resources[key]}}</span><strong>{{formatBillingAmount(balance(key)?.available ?? 0,key)}}</strong><small>长期有效：{{formatBillingAmount(balance(key)?.permanent ?? 0,key)}} · 预占：{{formatBillingAmount(balance(key)?.reserved ?? 0,key)}}</small><small v-if="balance(key)?.next_expiry">最近到期：{{date(balance(key)?.next_expiry)}}</small></div></div>
    <details><summary>额度来源与有效期</summary><div class="table-scroll"><table><thead><tr><th>来源</th><th>额度</th><th>剩余</th><th>生效时间</th><th>有效期</th></tr></thead><tbody><tr v-for="g in report.grants ?? []" :key="g.id"><td>{{g.name || sources[g.source] || '人工发放'}}</td><td>{{resources[g.resource]}}</td><td>{{formatBillingAmount(g.remaining,g.resource)}}</td><td>{{date(g.valid_from)}}</td><td>{{g.expires_at?date(g.expires_at):'长期有效'}}</td></tr><tr v-if="!report.grants?.length"><td colspan="5">暂无额度批次</td></tr></tbody></table></div></details>
    <details><summary>当前扣费规则</summary><ul><li v-for="(rule,key) in report.rules" :key="key">{{operations[key]}}：{{report.enabled && rule.enabled && rule.quantity ? '每 '+(key==='interview_audio'?formatBillingAmount(rule.unitSize,'interview_seconds'):rule.unitSize)+(key==='interview_audio'?' 分钟':key==='ocr'?' 页':' 次')+'扣除 '+formatBillingAmount(rule.quantity,rule.resource)+' '+resources[rule.resource] : '不单独扣费'}}</li></ul><p class="hint">转写按同一场面试的覆盖时长合并计量，默认累计不足一分钟按一分钟扣除。已开始的任务以当时的规则为准。</p></details>
    <details open><summary>最近额度流水</summary><div class="table-scroll"><table><thead><tr><th>业务</th><th>额度变化</th><th>状态</th><th>规则版本</th><th>时间</th></tr></thead><tbody><tr v-for="item in report.tasks" :key="item.id"><td>{{operations[item.operation]}}</td><td>{{item.state==='released'?'已退回 ':item.state==='settled'?'扣除 ':'预占 '}}{{formatBillingAmount(item.units,item.resource)}} {{resources[item.resource]}}</td><td>{{states[item.state]}}</td><td>{{item.policyVersion ?? item.policy_version ?? '—'}}</td><td>{{date(item.createdAt ?? item.created_at)}}</td></tr><tr v-if="!report.tasks.length"><td colspan="5">暂无额度使用记录</td></tr></tbody></table></div><p class="hint">显示最近 50 条任务。预占会暂时减少可用余额，明确失败后退回；结果不确定时由平台核对。</p></details>
  </template>
</section>
</template>
<style scoped>
.billing-panel{padding:24px;border:1px solid #dce5ef;border-radius:16px;background:white;margin-bottom:24px;min-width:0}.billing-panel header{display:flex;justify-content:space-between;align-items:center;gap:16px}.billing-panel h2{margin:0}.billing-panel p{line-height:1.6}.balances{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:20px 0}.balances>div{display:grid;gap:8px;padding:18px;background:#f5f8fc;border-radius:12px}.balances strong{font-size:28px;color:#185895}.balances small,.hint{color:#66768b}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:640px}th,td{padding:12px;text-align:left;border-bottom:1px solid #e5eaf0}details{margin-top:18px}summary{cursor:pointer;font-weight:600}.error{color:#af2424}button{padding:9px 16px;border:1px solid #cbd5e1;border-radius:8px;background:white;cursor:pointer}button:disabled{opacity:.5}@media(max-width:600px){.billing-panel{padding:16px}.balances{grid-template-columns:1fr}.billing-panel header{align-items:flex-start}.balances strong{font-size:24px}}
</style>
