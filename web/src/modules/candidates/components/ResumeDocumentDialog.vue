<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getResumeDocument, type ApiResumeDocument } from '../api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'

const props = defineProps<{ candidateId: string; resumeId: string; filename: string }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
const loading = ref(true)
const error = ref('')
const document = ref<ApiResumeDocument>()
const fileUrl = ref('')
const text = ref('')
const wordHtml = ref('')
let active = true
let loadToken = 0
let previousFocus: HTMLElement | null = null
const isPdf = computed(() => document.value?.originalFilename.toLowerCase().endsWith('.pdf'))
const isText = computed(() => /\.(txt|md)$/i.test(document.value?.originalFilename ?? ''))
const isWord = computed(() => document.value?.originalFilename.toLowerCase().endsWith('.docx'))

function safeWordPreview(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  parsed.querySelectorAll('script,style,iframe,object,embed,form,link,meta,svg,math').forEach(node => node.remove())
  parsed.querySelectorAll('*').forEach(node => {
    for (const attr of [...node.attributes]) {
      if (attr.name.startsWith('on') || ['href', 'srcset', 'style'].includes(attr.name)) node.removeAttribute(attr.name)
      if (attr.name === 'src' && !(node.tagName === 'IMG' && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(attr.value))) node.removeAttribute(attr.name)
    }
  })
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{max-width:820px;margin:0 auto;padding:28px;font:14px/1.8 Arial,sans-serif;color:#263445;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}td,th{border:1px solid #dce3e9;padding:6px 10px}h1{font-size:24px}h2{font-size:20px}h3{font-size:17px}p{margin:0 0 12px}</style></head><body>${parsed.body.innerHTML}</body></html>`
}

async function load() {
  const token = ++loadToken
  loading.value = true
  error.value = ''
  try {
    const result = await getResumeDocument(props.candidateId, props.resumeId)
    if (!active || token !== loadToken) return
    const bytes = Uint8Array.from(atob(result.content), char => char.charCodeAt(0))
    const mimeType = result.originalFilename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'
    if (fileUrl.value) URL.revokeObjectURL(fileUrl.value)
    fileUrl.value = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
    document.value = result
    if (/\.(txt|md)$/i.test(result.originalFilename)) text.value = new TextDecoder().decode(bytes)
    if (isWord.value && result.previewHtml) wordHtml.value = safeWordPreview(result.previewHtml)
  } catch (cause) {
    if (active && token === loadToken) error.value = describeApiFailure(cause, '无法读取原文档，请稍后重试').message
  } finally {
    if (active && token === loadToken) loading.value = false
  }
}

onMounted(() => {
  previousFocus = window.document.activeElement as HTMLElement | null
  dialog.value?.showModal()
  void load()
})
onBeforeUnmount(() => {
  active = false
  if (fileUrl.value) URL.revokeObjectURL(fileUrl.value)
  dialog.value?.close()
  previousFocus?.focus()
})
</script>

<template>
  <dialog ref="dialog" class="resume-document-dialog" aria-labelledby="resume-document-title" @keydown.stop @cancel.prevent="emit('close')" @click="event => { if (event.target === dialog) emit('close') }">
    <section class="document-layout">
      <header class="document-header">
        <div class="document-heading"><h2 id="resume-document-title">原始简历</h2><p :title="document?.originalFilename || filename">{{ document?.originalFilename || filename }}</p></div>
        <div class="document-actions">
          <a v-if="fileUrl && document" class="btn btn-primary btn-sm" :href="fileUrl" :download="document.originalFilename">下载原文件</a>
          <button class="btn btn-ghost document-close" type="button" aria-label="关闭原文档" title="关闭" autofocus @click="emit('close')">×</button>
        </div>
      </header>
      <div v-if="loading" class="document-empty" role="status">正在读取原文档...</div>
      <div v-else-if="error" class="document-empty" role="alert"><p>{{ error }}</p><button class="btn btn-ghost" type="button" @click="load">重试</button></div>
      <iframe v-else-if="isPdf && fileUrl" class="document-frame" :src="fileUrl" title="原始简历 PDF" />
      <iframe v-else-if="isWord && wordHtml" class="document-frame" :srcdoc="wordHtml" sandbox="" referrerpolicy="no-referrer" title="原始 Word 简历内容" />
      <pre v-else-if="isText" class="document-text">{{ text }}</pre>
      <div v-else class="document-empty"><p>此文件暂不支持在线预览，请下载原文件查看。</p></div>
      <footer v-if="!loading && !error && isWord && wordHtml" class="document-footer">Word 内容预览，原始排版以下载文件为准。</footer>
    </section>
  </dialog>
</template>

<style scoped>
.resume-document-dialog { width: min(1060px, calc(100vw - 32px)); height: min(850px, calc(100dvh - 48px)); max-width: none; max-height: none; padding: 0; border: 1px solid #dce4ed; border-radius: 8px; color: #263445; background: #fff; overflow: hidden; box-shadow: 0 18px 60px #0003; }
.resume-document-dialog::backdrop { background: #17212b66; }
.document-layout { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.document-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; border-bottom: 1px solid #e2e8f0; }
.document-heading { min-width: 0; }
.document-heading h2 { margin: 0; font-size: 17px; }
.document-heading p { margin: 5px 0 0; font-size: 12px; color: #64748b; overflow-wrap: anywhere; }
.document-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.document-actions a { text-decoration: none; white-space: nowrap; }
.document-close { width: 32px; height: 32px; padding: 0; font-size: 22px; }
.document-frame { flex: 1; width: 100%; min-height: 0; border: 0; background: #fff; }
.document-text { flex: 1; overflow: auto; margin: 0; padding: 24px; white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.8 Arial,sans-serif; }
.document-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; font-size: 14px; color: #64748b; overflow: auto; }
.document-footer { padding: 9px 20px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 12px; }
@media (max-width: 600px) { .document-header { padding: 12px; gap: 8px; } .document-actions { gap: 6px; } .document-text { padding: 16px; } }
</style>

