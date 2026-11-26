<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { getServiceThread, replyServiceThread, getServiceAttachment, type ServiceThread } from '../api/payments'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import SupportAttachmentPicker from './SupportAttachmentPicker.vue'
import { encodeSupportFiles, saveSupportAttachment } from './support-files'
const props = defineProps<{ requestId: string; organizationId?: string }>()
const emit = defineEmits<{ changed: [] }>()
const expanded=ref(false), thread=ref<ServiceThread|null>(null), busy=ref(false), error=ref(''), notice=ref(''), message=ref(''), files=ref<File[]>([])
let generation=0
watch(() => [props.requestId,props.organizationId],()=>{generation++;thread.value=null;expanded.value=false;message.value='';files.value=[];error.value='';notice.value='';busy.value=false})
onBeforeUnmount(()=>generation++)
async function load(older=false) {
  if (busy.value) return
  const current=++generation, id=props.requestId, org=props.organizationId, before=older ? thread.value?.nextBefore ?? undefined : undefined
  busy.value=true; error.value=''
  try {
    const result=await getServiceThread(id,org,before)
    if (current!==generation) return
    thread.value = older && thread.value ? {...result,messages:[...result.messages,...thread.value.messages],request:thread.value.request} : result
  } catch(cause) {if(current===generation)error.value=describeApiFailure(cause,'读取工单会话失败').message}
  finally {if(current===generation)busy.value=false}
}
function toggle() { expanded.value=!expanded.value; if(expanded.value && !thread.value)void load() }
async function send(resolve=false) {
  if(busy.value || message.value.trim().length<2)return
  const current=++generation,id=props.requestId,org=props.organizationId
  busy.value=true;error.value='';notice.value=''
  try {
    const attachments=await encodeSupportFiles(files.value)
    if(current!==generation)return
    const result=await replyServiceThread(id,{message:message.value.trim(),attachments,...(!org?{resolve}:{})},org)
    if(current!==generation)return
    thread.value=result;message.value='';files.value=[];notice.value=resolve?'已回复并完成工单':'消息已发送，可继续在此沟通';emit('changed')
  }catch(cause){if(current===generation)error.value=describeApiFailure(cause,'发送消息失败').message}
  finally{if(current===generation)busy.value=false}
}
async function download(attachmentId:string) {
  if(busy.value)return
  const current=++generation,id=props.requestId,org=props.organizationId
  busy.value=true;error.value=''
  try{const file=await getServiceAttachment(id,attachmentId,org);if(current===generation)saveSupportAttachment(file)}
  catch(cause){if(current===generation)error.value=describeApiFailure(cause,'下载附件失败').message}
  finally{if(current===generation)busy.value=false}
}
</script>
<template>
  <section class="service-thread" aria-label="工单会话">
    <button type="button" :aria-expanded="expanded" @click="toggle">{{ expanded ? '收起会话' : '查看会话 / 附件 / 继续追问' }}</button>
    <div v-if="expanded">
      <p v-if="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="busy" role="status">正在处理…</p>
      <template v-if="thread">
        <p>当前状态：{{ thread.request.status === 'open' ? '待处理' : '已完成' }}</p>
        <button type="button" :disabled="busy" @click="load(false)">刷新会话</button>
        <button v-if="thread.hasMore" type="button" :disabled="busy" @click="load(true)">加载更早消息</button>
        <article v-for="item in thread.messages" :key="item.id" class="message">
          <strong>{{ item.authorKind === 'administrator' ? '系统管理员' : '企业成员' }} · {{ new Date(item.createdAt).toLocaleString('zh-CN') }}</strong>
          <p class="message-text">{{ item.message }}</p>
          <ul v-if="item.attachments.length"><li v-for="file in item.attachments" :key="file.id"><button type="button" :disabled="busy" @click="download(file.id)">下载 {{ file.filename }}（{{ Math.ceil(file.sizeBytes/1024) }} KB）</button></li></ul>
        </article>
        <p v-if="thread.request.status === 'resolved'">继续发送消息会重新打开此工单；企业如已有其他待处理工单，请在那张工单继续沟通。</p>
        <form @submit.prevent="send(false)">
          <label>{{ organizationId ? '继续追问 / 补充说明' : '回复企业成员' }}<textarea v-model="message" :aria-label="organizationId ? '继续追问 / 补充说明' : '回复企业成员'" required minlength="2" maxlength="2000" :disabled="busy" /></label>
          <SupportAttachmentPicker v-model="files" :disabled="busy" />
          <button type="submit" :disabled="busy || message.trim().length<2">{{ organizationId ? '发送追问' : '仅回复，保持待处理' }}</button>
          <button v-if="!organizationId" type="button" :disabled="busy || message.trim().length<2" @click="send(true)">回复并完成工单</button>
        </form>
      </template>
      <button v-else-if="!busy" type="button" @click="load()">重新读取会话</button>
    </div>
  </section>
</template>
<style scoped>
.service-thread {margin-top:12px;min-width:0;} button {padding:8px 12px;border:1px solid #bfd2df;border-radius:8px;background:#f4f8fc;color:#183049;cursor:pointer;max-width:100%;overflow-wrap:anywhere;margin:4px 4px 4px 0;}button:disabled{opacity:.6;cursor:default;}.message {padding:12px;background:#f5f8fb;border-radius:8px;margin:12px 0;}.message-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;}label{display:grid;gap:8px;}textarea{width:100%;box-sizing:border-box;min-height:90px;padding:10px;font:inherit;}[role=alert]{color:#a52335;}ul{padding-left:20px;}
</style>
