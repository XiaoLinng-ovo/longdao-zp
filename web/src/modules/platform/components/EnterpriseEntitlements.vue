<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { assignPlan, getEntitlements, listPlans, publishPlan, type Entitlements, type PlanVersion } from '../api/entitlements'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
const emit=defineEmits<{ready:[organizationId:string]}>()
const props=defineProps<{organizationId:string;name:string;platform?:boolean;canWrite?:boolean}>()
const summary=ref<Entitlements|null>(null),plans=ref<PlanVersion[]>([]),selected=ref(''),reason=ref(''),busy=ref(false),error=ref(''),notice=ref('')
const publishing=ref(false),code=ref(''),version=ref(1),planName=ref(''),seatLimit=ref(5),jobLimit=ref(20),publishReason=ref('')
const capacity=(value:number|null)=>value===null?'不限（历史兼容）':String(value)
async function load() {
  busy.value=true;error.value=''
  try {summary.value=await getEntitlements(props.organizationId,props.platform);selected.value=summary.value.plan.id;if(props.platform)plans.value=await listPlans()}
  catch(e){summary.value=null;error.value=describeApiFailure(e,'读取企业权益失败').message}finally{busy.value=false}
}
async function save() {
  if(busy.value||!props.canWrite||!summary.value)return
  error.value='';notice.value=''
  if(reason.value.trim().length<2||reason.value.trim().length>500){error.value='请填写 2～500 字的变更原因';return}
  busy.value=true
  try{summary.value=await assignPlan(props.organizationId,selected.value,summary.value.entitlementVersion,reason.value.trim());reason.value='';notice.value='套餐权益已更新，并记录平台审计。服务状态不会自动改变。'}
  catch(e){error.value=describeApiFailure(e,'变更失败，请刷新权益后重试').message}finally{busy.value=false}
}
async function publish() {
  if(busy.value||!props.canWrite)return
  error.value='';notice.value='';busy.value=true
  try{const plan=await publishPlan({code:code.value,version:version.value,name:planName.value,seatLimit:seatLimit.value,jobLimit:jobLimit.value,reason:publishReason.value});plans.value=await listPlans();selected.value=plan.id;publishing.value=false;notice.value='新版本已发布；尚未分配给任何企业，已有客户权益不变。'}
  catch(e){error.value=describeApiFailure(e,'发布失败').message}finally{busy.value=false}
}
onMounted(async () => { await load(); emit('ready', props.organizationId) })
</script>
<template>
  <section class="entitlements" aria-label="套餐及权益">
    <header><div><h2>{{ name }} · 套餐及权益</h2><p>席位包含所有成员（含所有者）；岗位容量包含全部状态的岗位，不是每月 AI 消费额度。</p></div><button type="button" :disabled="busy" @click="load">刷新权益</button></header>
    <p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="notice" class="success" role="status">{{ notice }}</p>
    <p v-if="busy" role="status">正在处理…</p>
    <template v-if="summary">
      <div class="usage"><div><small>当前套餐（固定版本）</small><strong>{{ summary.plan.name }} · v{{ summary.plan.version }}</strong></div><div><small>成员席位</small><strong>{{ summary.seats.used }} / {{ capacity(summary.seats.limit) }}</strong></div><div><small>岗位容量</small><strong>{{ summary.jobs.used }} / {{ capacity(summary.jobs.limit) }}</strong></div></div>
      <p>权益版本 {{ summary.entitlementVersion }} · {{ summary.serviceAvailable ? '服务可用' : '服务暂不可用，请联系平台运营' }}。套餐变更不会恢复暂停或延长试用；邀请创建不占席位，实际加入时校验。</p>
      <form v-if="platform && canWrite" @submit.prevent="save">
        <label>分配套餐版本<select v-model="selected" :disabled="busy"><option v-for="plan in plans" :key="plan.id" :value="plan.id">{{ plan.name }} v{{ plan.version }} · {{ capacity(plan.seatLimit) }} 席位 / {{ capacity(plan.jobLimit) }} 岗位</option></select></label>
        <label>变更原因<textarea v-model="reason" rows="2" maxlength="500" :disabled="busy" placeholder="请说明本次套餐调整原因" /></label>
        <div class="actions"><button type="submit" :disabled="busy || selected===summary.plan.id">保存企业套餐</button><button type="button" :disabled="busy" @click="publishing=!publishing">{{ publishing?'收起发布':'发布新套餐版本' }}</button></div>
        <small>不自动删除超额数据；降级容量小于已有用量时会拒绝保存。本页不收费、不开通自动续费。</small>
      </form>
      <p v-else>你可以查看权益；套餐分配由平台管理员处理。购买及支付入口尚未开放。</p>
      <form v-if="platform && canWrite && publishing" class="publish" @submit.prevent="publish">
        <h3>发布不可变套餐版本</h3><p>同一编码 + 版本只可发布一次；调整容量需发布新版本，再显式分配客户。</p>
        <div class="fields"><label>套餐编码<input v-model="code" required pattern="[a-z][a-z0-9_-]{1,39}" maxlength="40" :disabled="busy" placeholder="例如 team" /></label><label>版本号<input v-model.number="version" type="number" min="1" max="1000000" required :disabled="busy" /></label><label>套餐名称<input v-model="planName" minlength="2" maxlength="80" required :disabled="busy" /></label><label>成员席位<input v-model.number="seatLimit" type="number" min="1" max="1000000" required :disabled="busy" /></label><label>岗位容量<input v-model.number="jobLimit" type="number" min="1" max="1000000" required :disabled="busy" /></label></div>
        <label>发布原因<textarea v-model="publishReason" minlength="2" maxlength="500" required :disabled="busy" /></label><button type="submit" :disabled="busy">发布新版本（不自动分配）</button>
      </form>
    </template>
  </section>
</template>
<style scoped>
.entitlements{padding:22px;border:1px solid #d4e9e5;border-radius:18px;background:linear-gradient(115deg,#f0faf6,#f2f7ff);color:#31576a;margin:16px 0}header{display:flex;justify-content:space-between;gap:16px;align-items:start}h2{font-size:17px;margin:0}h3{font-size:15px}p,small{font-size:12px;line-height:1.8;color:#688699}.usage{display:flex;gap:16px;flex-wrap:wrap;margin:18px 0}.usage>div{display:grid;gap:8px;flex:1;min-width:160px;background:#ffffffb3;border:1px solid #dcebe8;padding:16px;border-radius:12px}strong{font-size:15px}form,label{display:grid;gap:10px}form{gap:16px;margin-top:16px}label{font-size:12px}input,select,textarea{font:inherit;padding:10px;border:1px solid #cedfe6;border-radius:9px;color:#31576a;background:#fff;max-width:100%;box-sizing:border-box}button{padding:10px 12px;border:1px solid #88bbb1;border-radius:9px;background:#e0f2eb;color:#366f65;cursor:pointer;font:inherit;font-size:12px}button:disabled{opacity:.5;cursor:not-allowed}.fields,.actions{display:flex;gap:12px;flex-wrap:wrap}.fields label{flex:1;min-width:140px}.publish{border-top:1px solid #cbdedc;padding-top:14px}.error,.success{padding:12px;border-radius:10px}.error{background:#fff0f0;color:#a43b42}.success{background:#e0f4e7;color:#397858}
</style>
