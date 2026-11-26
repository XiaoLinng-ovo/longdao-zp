<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { LogOut, UserMinus, X } from '@lucide/vue'
import { apiClient } from '../../../shared/api'
import { authSession } from '../session'
import type { WorkspaceSummary } from '../api'
import { listWorkspaceMembers, type WorkspaceMember } from '../api/invitations'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
const props=defineProps<{workspace:WorkspaceSummary}>()
const admin=computed(()=>props.workspace.membershipActive!==false && ['owner','admin'].includes(props.workspace.role))
const requests=ref<{id:string;user_id:string;name:string;reason:string}[]>([])
const members=ref<WorkspaceMember[]>([]), target=ref(''), replacement=ref(''), reason=ref('')
const busy=ref(false), error=ref(''), notice=ref('')
let generation=0
onBeforeUnmount(()=>{generation++})
const base=computed(()=>'/workspaces/'+encodeURIComponent(props.workspace.id))
const eligible=computed(()=>members.value.filter(m=>m.id!==authSession.user?.id && m.membershipRole!=='owner' && (props.workspace.role==='owner' || m.membershipRole==='member')))
const receivers=computed(()=>members.value.filter(m=>m.id!==target.value && m.isActive && m.accountActive))
async function load() {
  const current=++generation
  try {
    const [r,m]=await Promise.all([apiClient.getJson<typeof requests.value>(base.value+'/exit-requests'),admin.value ? listWorkspaceMembers(props.workspace.id):Promise.resolve([])])
    if(current!==generation)return
    requests.value=r.data;members.value=m
  } catch(cause) { if(current===generation)error.value=describeApiFailure(cause,'读取退出申请失败').message }
}
watch(()=>props.workspace.id,()=>{target.value='';replacement.value=authSession.user?.id ?? '';error.value='';notice.value='';void load()},{immediate:true})
async function submit(reject=false,ownRequest=false) {
  const manage=admin.value && !ownRequest
  if(busy.value)return
  if(reason.value.trim().length<2){error.value='请填写至少 2 个字的原因';return}
  if(manage && !target.value){error.value='请选择需要办理退出的成员';return}
  if(manage && !reject && !replacement.value){error.value='请选择责任接收人';return}
  if(manage && !window.confirm(reject ? '确认驳回此退出申请？' : '确认解除成员绑定？未完成事务将交接给所选接收人，原企业数据不会转移。'))return
  busy.value=true;error.value='';notice.value=''
  try {
    if(manage)await apiClient.postJson(base.value+'/members/'+encodeURIComponent(target.value)+'/depart',{reason:reason.value.trim(),replacementId:replacement.value,reject})
    else await apiClient.postJson(base.value+'/exit-requests',{reason:reason.value.trim()})
    notice.value=manage ? reject ? '已驳回退出申请':'已解除绑定并完成责任交接':'退出申请已提交'
    reason.value='';target.value='';await load()
  } catch(cause){error.value=describeApiFailure(cause,'退出操作失败').message}
  finally{busy.value=false}
}
async function requestOwnExit() { await submit(false,true) }
</script>

<template>
  <section class="membership-section" aria-label="企业成员退出">
    <h2>{{ admin ? '成员退出与交接' : '我的企业关系' }}</h2>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <ul v-if="requests.length" class="exit-requests">
      <li v-for="request in requests" :key="request.id"><span>{{ request.name }}：{{ request.reason }}</span><button v-if="admin && request.user_id!==authSession.user?.id" type="button" @click="target=request.user_id;reason=''">办理</button><span v-else>等待管理员办理</span></li>
    </ul>
    <form v-if="admin || workspace.role!=='owner'" @submit.prevent="submit()">
      <label v-if="admin">退出成员<select v-model="target" :disabled="busy"><option value="">请选择成员</option><option v-for="member in eligible" :key="member.id" :value="member.id">{{ member.name }}{{ member.isActive ? '' : '（已停用）' }}</option></select></label>
      <label v-if="admin">责任接收人<select v-model="replacement" :disabled="busy"><option value="">请选择接收人</option><option v-for="member in receivers" :key="member.id" :value="member.id">{{ member.name }}</option></select></label>
      <label>原因<textarea v-model="reason" maxlength="500" rows="2" :disabled="busy" /></label>
      <div class="membership-actions"><button type="submit" :disabled="busy"><UserMinus v-if="admin" :size="16" /><LogOut v-else :size="16" />{{ admin ? '交接并解除绑定' : '申请退出企业' }}</button><button v-if="workspace.role==='admin' && admin" type="button" :disabled="busy" @click="requestOwnExit"><LogOut :size="16" />申请本人退出</button><button v-if="admin && requests.some(r=>r.user_id===target)" type="button" :disabled="busy" @click="submit(true)"><X :size="16" />驳回申请</button></div>
    </form>
  </section>
</template>

<style scoped>
.membership-section { margin-top:24px; padding-top:20px; border-top:1px solid #dce7e8; }
h2 { font-size:16px; margin:0 0 14px; }
form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
label { display:grid; gap:6px; font-size:12px; min-width:0; }
label:has(textarea),.membership-actions { grid-column:1/-1; }
select,textarea { box-sizing:border-box; width:100%; min-width:0; padding:8px; border:1px solid #cbdadf; border-radius:6px; font:inherit; background:white; }
.membership-actions { display:flex; gap:10px; flex-wrap:wrap; }
button { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:8px 12px; border:1px solid #b9d4ce; border-radius:6px; background:#edf6f1; color:#276b54; cursor:pointer; }
button:disabled { opacity:.6; cursor:wait; }
.exit-requests { list-style:none; padding:0; font-size:13px; }
.exit-requests li { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:10px 0; border-bottom:1px solid #e7eded; }
.exit-requests span { overflow-wrap:anywhere; }
[role=alert] { color:#b42338; } [role=status] { color:#276b54; }
@media(max-width:600px) { form { grid-template-columns:minmax(0,1fr); } }
</style>
