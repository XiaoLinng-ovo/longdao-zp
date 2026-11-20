<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { X } from '@lucide/vue';
defineProps<{title:string;busy?:boolean}>();
const emit=defineEmits<{close:[]}>();
const dialog=ref<HTMLDialogElement>();
let previousFocus:HTMLElement|null=null;
onMounted(()=>{
  previousFocus=document.activeElement as HTMLElement|null;
  if (dialog.value?.showModal) dialog.value.showModal();
  else dialog.value?.setAttribute('open','');
});
onBeforeUnmount(()=>{dialog.value?.close?.();previousFocus?.focus?.()});
</script>
<template>
  <Teleport to="body">
    <dialog ref="dialog" class="payment-product-dialog" :aria-label="title" @cancel.prevent="!busy && emit('close')">
      <header><h2>{{title}}</h2><button type="button" :disabled="busy" aria-label="关闭" title="关闭" @click="emit('close')"><X :size="20" /></button></header>
      <div class="dialog-content"><slot /></div>
      <footer><slot name="actions" /></footer>
    </dialog>
  </Teleport>
</template>
<style scoped>
.payment-product-dialog{position:fixed;inset:0;border:1px solid #d5dfe7;border-radius:8px;padding:0;width:min(820px,calc(100vw - 32px));max-height:calc(100dvh - 32px);color:#253b45;background:white;overflow:auto;overscroll-behavior:contain;box-sizing:border-box}
.payment-product-dialog::backdrop{background:#142a3c66}
header,footer{display:flex;align-items:center;gap:12px;padding:16px 20px;background:white;position:sticky;z-index:1}
header{top:0;justify-content:space-between;border-bottom:1px solid #d5dfe7}h2{font-size:18px;margin:0}header button{width:32px;height:32px;border:0;background:transparent;display:grid;place-items:center;cursor:pointer}
.dialog-content{padding:20px;overflow-wrap:anywhere}footer{bottom:0;justify-content:flex-end;border-top:1px solid #d5dfe7;flex-wrap:wrap}
</style>
