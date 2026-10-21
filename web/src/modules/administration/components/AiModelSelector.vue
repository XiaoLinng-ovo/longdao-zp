<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

const props = withDefaults(defineProps<{ modelValue: string; options: string[]; disabled?: boolean; id?: string }>(), { disabled: false, id: 'ai-model' })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const root = ref<HTMLElement | null>(null)
const modelInput = ref<HTMLInputElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const expanded = ref(false)
const search = ref('')
const choices = computed(() => [...new Set(props.options.map(option => option.trim()).filter(Boolean))])
const filteredChoices = computed(() => choices.value.filter(option => option.toLowerCase().includes(search.value.trim().toLowerCase())))

async function openChoices() {
  if (props.disabled) return
  search.value = '' // Show all models even when a custom ID is already typed.
  expanded.value = true
  await nextTick()
  searchInput.value?.focus()
}
function closeChoices(restoreFocus = false) {
  expanded.value = false
  if (restoreFocus) modelInput.value?.focus()
}
function choose(model: string) {
  emit('update:modelValue', model)
  closeChoices(true)
}
function onFocusOut(event: FocusEvent) {
  if (!root.value?.contains(event.relatedTarget as Node | null)) closeChoices()
}
function focusOption(index: number) {
  const buttons = root.value?.querySelectorAll<HTMLButtonElement>('[role="option"]')
  if (buttons?.length) buttons[(index + buttons.length) % buttons.length]?.focus()
}
watch(() => props.disabled, disabled => { if (disabled) closeChoices() })
</script>

<template>
  <div ref="root" class="model-selector" @focusout="onFocusOut" @keydown.esc.stop.prevent="closeChoices(true)">
    <div class="model-input-row">
      <input
        :id="id" ref="modelInput" :value="modelValue" :disabled="disabled"
        role="combobox" aria-autocomplete="none" aria-haspopup="listbox" :aria-expanded="expanded"
        :aria-controls="`${id}-options`" :aria-describedby="`${id}-hint`"
        placeholder="选择模型，或手动输入模型 ID" autocomplete="off"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        @keydown.down.prevent="openChoices"
      />
      <button class="model-toggle" type="button" :disabled="disabled" :aria-expanded="expanded" :aria-controls="`${id}-options`" aria-label="选择模型" @click="expanded ? closeChoices(true) : openChoices()">
        <span>选择</span><span aria-hidden="true">⌄</span>
      </button>
    </div>
    <small :id="`${id}-hint`" class="model-hint">{{ choices.length ? `可选 ${choices.length} 个模型，也可手动输入。` : '测试连接后可选择模型，也可手动输入。' }}选择后需保存模型配置。</small>
    <div v-if="expanded" class="model-dropdown">
      <input ref="searchInput" v-model="search" class="model-search" aria-label="搜索可用模型" placeholder="搜索模型名称" autocomplete="off" @keydown.down.prevent="focusOption(0)" @keydown.up.prevent="focusOption(filteredChoices.length - 1)" />
      <div :id="`${id}-options`" class="model-options" role="listbox" aria-label="可用模型">
        <button v-for="(model, index) in filteredChoices" :key="model" class="model-option" type="button" role="option" :aria-selected="model === modelValue" @click="choose(model)" @keydown.down.prevent="focusOption(index + 1)" @keydown.up.prevent="focusOption(index - 1)">
          <span>{{ model }}</span><span v-if="model === modelValue" aria-hidden="true">✓</span>
        </button>
      </div>
      <p v-if="!choices.length" class="model-empty">暂无模型列表，请先测试连接；也可以直接输入服务商提供的模型 ID。</p>
      <p v-else-if="!filteredChoices.length" class="model-empty">没有匹配的模型，可在上方模型输入框中手动填写。</p>
    </div>
  </div>
</template>

<style scoped>
.model-selector{position:relative;min-width:0}.model-input-row{display:flex;gap:8px;align-items:stretch}.model-input-row input,.model-search{box-sizing:border-box;min-width:0;width:100%;border:1px solid #d5e2ed;border-radius:7px;padding:9px 10px;background:#fff;color:#334155;font:inherit;font-size:13px}.model-input-row input{flex:1}.model-input-row input:focus,.model-search:focus{outline:2px solid #a4c7f5;outline-offset:1px}.model-toggle{display:flex;align-items:center;gap:6px;flex-shrink:0;border:1px solid #ccdfed;border-radius:7px;padding:0 11px;background:#eef7fb;color:#487589;font:inherit;font-size:12px;cursor:pointer}.model-toggle:hover{background:#e1eff8}.model-toggle:focus-visible,.model-option:focus-visible{outline:2px solid #86b8ef;outline-offset:-2px}.model-toggle:disabled,input:disabled{opacity:.55;cursor:not-allowed}.model-hint{display:block;margin-top:7px;color:#7a91a6;font-size:11px;line-height:1.6}.model-dropdown{position:absolute;z-index:30;top:calc(100% + 6px);left:0;right:0;padding:10px;border:1px solid #d5e4ed;border-radius:11px;background:#fff;box-shadow:0 10px 30px #31576a24}.model-search{background:#f6fafd}.model-options{max-height:220px;overflow-y:auto;margin-top:7px}.model-option{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;border:0;border-radius:6px;padding:10px;text-align:left;background:transparent;color:#3d5369;font:inherit;font-size:13px;cursor:pointer;overflow-wrap:anywhere}.model-option:hover,.model-option[aria-selected="true"]{background:#edf7f5;color:#308379}.model-option span:first-child{min-width:0}.model-empty{margin:8px 3px 2px;color:#7b8c9c;font-size:12px;line-height:1.7}
</style>
