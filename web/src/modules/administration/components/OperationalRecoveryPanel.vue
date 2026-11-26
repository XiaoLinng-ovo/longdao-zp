<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { RefreshCw, X } from '@lucide/vue'
import { listUnresolvedEmailDeliveries, resolveEmailDelivery, listOperationalRecovery, resolveOperationalTask, type UnresolvedEmailDelivery, type OperationalRecovery } from '../api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'

const props=withDefaults(defineProps<{initialTab?:'email'|'cleanup'}>(),{initialTab:'email'})
const tab=ref<'email'|'cleanup'|'audio'|'refund'>(props.initialTab)
const tabs=[{id:'email',label:'邮件核对'},{id:'cleanup',label:'文件清理'},{id:'audio',label:'整场转写'},{id:'refund',label:'退款查单'}] as const
const deliveries=ref<UnresolvedEmailDelivery[]>([])
const tasks=ref<OperationalRecovery>({cleanup:[],audio:[],refund:[]})
const loading=ref(false),saving=ref(false),error=ref(''),success=ref('')
const decision=ref<{kind:'email'|'cleanup'|'audio';id:string;action:'completed'|'not_sent'|'retry'|'stop';label:string;version:string}|null>(null)
const note=ref(''),confirmed=ref(false)
const dialog=ref<HTMLDialogElement | null>(null)
let returnFocus: HTMLElement | null = null
const rows=computed(()=>tab.value==='email' ? [] : tasks.value[tab.value])
const short=(value:string)=>value.slice(0,8)
const date=(value?:string)=>value ? new Date(value).toLocaleString() : '待调度'
const states:Record<string,string>={sending:'发送中',accepted:'SMTP 已接受，业务待核对',unknown:'结果未知',failed:'失败',refund_pending:'退款待确认'}
const state=(value:string)=>states[value] ?? value
const noteValid=computed(()=>note.value.trim().length>=5 && note.value.length<=2000 && confirmed.value && (decision.value?.kind==='email' || /^[0-9]{1,10}$/.test(decision.value?.version ?? '')))
async function load() {
  loading.value=true; error.value=''
  try { const [email,operations]=await Promise.all([listUnresolvedEmailDeliveries(),listOperationalRecovery()]); deliveries.value=email; tasks.value=operations }
  catch(cause) { error.value=describeApiFailure(cause,'读取异常任务失败，请核对数据库结构').message }
  finally { loading.value=false }
}
async function open(kind:'email'|'cleanup'|'audio',id:string,action:'completed'|'not_sent'|'retry'|'stop',label:string) {
  returnFocus=document.activeElement instanceof HTMLElement ? document.activeElement : null
  const version=kind==='email' ? '' : tasks.value[kind].find(task=>task.id===id)?.recovery_version ?? ''
  decision.value={kind,id,action,label,version}; note.value=''; confirmed.value=false; error.value=''; success.value=''
  await nextTick()
  dialog.value?.showModal()
}
function close() {
  if (saving.value) return
  dialog.value?.close(); decision.value=null; returnFocus?.focus()
}
async function submit() {
  const value=decision.value
  if (!value || !noteValid.value || saving.value) return
  saving.value=true; error.value=''
  try {
    if (value.kind==='email') await resolveEmailDelivery(value.id,value.action as 'completed'|'not_sent',note.value.trim())
    else await resolveOperationalTask(value.kind,value.id,value.action as 'retry'|'stop',note.value.trim(),value.version)
    dialog.value?.close(); decision.value=null; returnFocus?.focus(); success.value='核对结果已记录'; await load()
  } catch(cause) { error.value=describeApiFailure(cause,'提交核对结果失败').message }
  finally { saving.value=false }
}
onMounted(load)
</script>

<template>
  <section class="recovery-section" aria-label="异常任务核对">
    <header class="recovery-heading"><h3>异常任务核对</h3><button class="btn btn-ghost icon-button" type="button" title="刷新异常任务" aria-label="刷新异常任务" :disabled="loading || saving" @click="load"><RefreshCw :size="18" /></button></header>
    <div class="recovery-tabs" role="tablist" aria-label="任务类型"><button v-for="item in tabs" :key="item.id" type="button" role="tab" :aria-selected="tab===item.id" :class="{selected:tab===item.id}" @click="tab=item.id">{{ item.label }}</button></div>
    <p v-if="error" role="alert" class="recovery-error">{{ error }}</p><p v-if="success" role="status" class="recovery-success">{{ success }}</p>
    <p v-if="loading" role="status">正在读取任务...</p>
    <div v-else class="recovery-table">
      <table v-if="tab==='email'"><thead><tr><th>公司 / Offer</th><th>投递标识</th><th>状态 / 时间</th><th>核对结果</th></tr></thead><tbody>
        <tr v-for="item in deliveries" :key="item.id"><td><span :title="item.organization_id">{{ short(item.organization_id) }}</span><br /><span :title="item.offer_id">{{ short(item.offer_id) }}</span></td><td class="message-id">{{ item.message_id }}</td><td>{{ state(item.status) }}<br />{{ date(item.updated_at) }}</td><td><div class="recovery-actions"><button type="button" class="btn btn-ghost btn-sm" @click="open('email',item.id,'completed','确认 SMTP 已接受并同步业务状态')">已接受</button><button type="button" class="btn btn-ghost btn-sm" @click="open('email',item.id,'not_sent','确认未发送，解除发送预留')">未发送</button></div></td></tr>
        <tr v-if="!deliveries.length"><td colspan="4" class="recovery-empty">暂无待核对邮件</td></tr>
      </tbody></table>
      <table v-else><thead><tr><th>公司 / 任务</th><th>状态 / 次数</th><th>最近结果</th><th>下次处理 / 操作</th></tr></thead><tbody>
        <tr v-for="item in rows" :key="item.id"><td><span :title="item.organization_id">{{ short(item.organization_id) }}</span><br /><span :title="item.id">{{ short(item.id) }}</span></td><td>{{ state(item.status) }} / {{ item.attempts ?? item.refund_check_attempts ?? 0 }}</td><td>{{ item.last_error || item.refund_check_error || '等待结果' }}</td><td><span v-if="tab==='refund'">{{ date(item.refund_next_check_at) }}</span><button v-else-if="tab==='cleanup'" type="button" class="btn btn-ghost btn-sm" @click="open('cleanup',item.id,'retry','重新排队清理文件')">重新排队</button><button v-else-if="item.status==='unknown'" type="button" class="btn btn-ghost btn-sm" @click="open('audio',item.id,'stop','核对并终止未知转写，不再自动重试')">核对并终止</button><span v-else>已停止</span></td></tr>
        <tr v-if="!rows.length"><td colspan="4" class="recovery-empty">暂无异常任务</td></tr>
      </tbody></table>
    </div>
    <dialog v-if="decision" ref="dialog" class="recovery-dialog" aria-labelledby="recovery-decision-title" @cancel.prevent="close">
      <form @submit.prevent="submit">
        <header class="recovery-heading"><h3 id="recovery-decision-title">{{ decision.label }}</h3><button class="btn btn-ghost icon-button" type="button" title="关闭核对" aria-label="关闭核对" :disabled="saving" @click="close"><X :size="18" /></button></header>
        <label for="recovery-note">核对依据</label><textarea id="recovery-note" v-model="note" rows="4" minlength="5" maxlength="2000" required autofocus />
        <p v-if="decision.kind==='audio'" class="recovery-warning">终止仅停止本平台后续处理，不表示服务商未执行或已退款。{{ tasks.audioLookup?.reason }}</p>
        <label class="recovery-confirm"><input v-model="confirmed" type="checkbox" /><span>已核实服务日志及业务记录，确认此操作<span v-if="decision.kind==='email'">；SMTP 接受不代表最终送达</span></span></label>
        <p v-if="error" role="alert" class="recovery-error">{{ error }}</p>
        <footer class="recovery-actions"><button class="btn btn-ghost" type="button" :disabled="saving" @click="close">取消</button><button class="btn btn-primary" type="submit" :disabled="!noteValid || saving">{{ saving ? '提交中...' : '记录核对结果' }}</button></footer>
      </form>
    </dialog>
  </section>
</template>

<style scoped>
.recovery-section{margin-top:24px;border-top:1px solid #d9dee5;padding-top:20px;min-width:0;color:#28323d}
.recovery-heading,.recovery-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.recovery-heading h3{font-size:17px;margin:0}.recovery-actions{justify-content:flex-end;flex-wrap:wrap}.icon-button{width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;padding:0;flex-shrink:0}
.recovery-tabs{display:flex;gap:16px;border-bottom:1px solid #d9dee5;margin:12px 0;overflow-x:auto}.recovery-tabs button{border:0;background:transparent;padding:10px 0;color:#5d6570;font:inherit;white-space:nowrap;border-bottom:2px solid transparent}.recovery-tabs .selected{color:#146d60;border-color:#146d60}
.recovery-table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px;text-align:left}th,td{padding:12px 8px;border-bottom:1px solid #e6e9ed;vertical-align:top}th{color:#596674;font-weight:600}td{overflow-wrap:anywhere;min-width:100px}.message-id{max-width:340px}.recovery-empty{text-align:center;padding:28px;color:#68727e}.recovery-error{color:#ad2838}.recovery-success{color:#146d60}
.recovery-dialog{background:white;border:1px solid #d9dee5;border-radius:8px;width:min(560px,100%);max-height:calc(100dvh - 32px);overflow:auto;padding:20px;display:block;box-sizing:border-box}.recovery-dialog textarea{width:100%;box-sizing:border-box;resize:vertical;padding:10px;font:inherit;border:1px solid #bcc5ce;border-radius:4px}.recovery-confirm{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:1.6}.recovery-confirm input{flex-shrink:0;margin-top:4px}
@media(max-width:600px){.recovery-tabs{gap:12px}.recovery-dialog{padding:16px}.recovery-heading h3{font-size:16px}.recovery-table table{min-width:560px}}
.recovery-dialog form{display:grid;gap:16px}.recovery-dialog::backdrop{background:#17212d70}
</style>
