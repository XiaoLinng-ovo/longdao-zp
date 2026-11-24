<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { getEnterpriseBilling, type EnterpriseBilling } from '../api/payments';
import { authSession } from '../../auth/session';
import { describeApiFailure } from '../../../shared/utils/errorMessage';
const report=ref<EnterpriseBilling|null>(null),busy=ref(false),error=ref('');
const scope=computed(()=>[authSession.user?.workspaceId,authSession.user?.id,authSession.sessionId].join(':'));
let version=0,alive=true;
async function load(){const org=authSession.user?.workspaceId,stamp=++version;report.value=null;error.value='';busy.value=!!org;if(!org)return;try{const result=await getEnterpriseBilling(org);if(alive && stamp===version)report.value=result}catch(e){if(alive && stamp===version)error.value=describeApiFailure(e,'读取执行状态失败').message}finally{if(alive && stamp===version)busy.value=false}}
watch(scope,()=>void load(),{immediate:true});onBeforeUnmount(()=>{alive=false;version++});
</script>
<template>
<section class="billing-panel" aria-label="企业执行状态">
  <header><h2>企业执行状态</h2><button :disabled="busy" @click="load">{{busy?'读取中…':'刷新状态'}}</button></header>
  <p v-if="error" class="error" role="alert">{{error}}</p>
  <template v-if="report">
    <details v-if="report.execution?.enabled" aria-label="执行通道"><summary>执行通道</summary><div class="table-scroll"><table><thead><tr><th>通道</th><th>正在执行</th><th>并发上限</th><th>交互保留位</th></tr></thead><tbody><tr><td>对话与后台生成</td><td>{{report.execution.text.active}}</td><td>{{report.execution.text.limit}}</td><td>{{report.execution.text.reservedInteractive}}</td></tr><tr><td>录音转写</td><td>{{report.execution.audio.active}}</td><td>{{report.execution.audio.limit}}</td><td>—</td></tr><tr><td>实时转写会话</td><td>{{report.execution.realtime.active}}</td><td>{{report.execution.realtime.limit}}</td><td>—</td></tr></tbody></table></div></details>
    <p v-if="report.serviceAvailable===false" class="hint">企业服务当前不可用，请续费订阅或联系平台管理员。</p>
  </template>
</section>
</template>
<style scoped>
.billing-panel{padding:24px 0;border-top:1px solid #dce5ef;margin-bottom:24px;min-width:0}.billing-panel header{display:flex;justify-content:space-between;align-items:center;gap:16px}.billing-panel h2{margin:0;font-size:18px}.billing-panel p{line-height:1.6}.hint{color:#66768b}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:640px}th,td{padding:12px;text-align:left;border-bottom:1px solid #e5eaf0}details{margin-top:18px}summary{cursor:pointer;font-weight:600}.error{color:#af2424}button{padding:9px 16px;border:1px solid #cbd5e1;border-radius:8px;background:white;cursor:pointer}button:disabled{opacity:.5}@media(max-width:600px){.billing-panel{padding:16px 0}.billing-panel header{align-items:flex-start}}
</style>
