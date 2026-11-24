<script setup lang="ts">
import { ref, watch } from 'vue'
import { validateSupportFiles } from './support-files'
const props = defineProps<{ modelValue: File[]; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [files: File[]] }>()
const error = ref(''), input = ref<HTMLInputElement>()
watch(() => props.modelValue, value => { if (!value.length && input.value) input.value.value = '' })
function select(event: Event) {
  const files = Array.from((event.target as HTMLInputElement).files ?? [])
  error.value = ''
  try { validateSupportFiles(files); emit('update:modelValue',files) }
  catch (cause) { error.value = (cause as Error).message; emit('update:modelValue',[]); (event.target as HTMLInputElement).value='' }
}
</script>
<template>
  <div class="support-attachments">
    <label>添加附件<input ref="input" type="file" accept=".png,.jpg,.jpeg,.pdf,.txt" multiple :disabled="disabled" @change="select" /></label>
    <small>PNG、JPG、PDF、TXT，每条消息最多 3 个，单个不超过 2 MB；每张工单附件总量最多 30 MB。</small>
    <ul v-if="modelValue.length"><li v-for="(file,index) in modelValue" :key="index">{{ file.name }}（{{ Math.ceil(file.size/1024) }} KB）<button type="button" :disabled="disabled" :aria-label="'移除附件 ' + file.name" @click="emit('update:modelValue',modelValue.filter((_,i)=>i!==index))">移除</button></li></ul>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
<style scoped>
.support-attachments { margin: 12px 0; overflow-wrap: anywhere; } label { display: grid; gap: 6px; } input { max-width: 100%; } small { display: block; margin: 6px 0; line-height: 1.6; } li { margin: 4px 0; } button { margin-left: 8px; } [role=alert] {color:#a52335;}
</style>
