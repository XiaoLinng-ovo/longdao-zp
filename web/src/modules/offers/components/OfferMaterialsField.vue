<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ modelValue: string[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const options: Array<[string, string]> = [
  ['graduation_certificate', '毕业证书、学位证书'], ['id_card', '身份证'],
  ['previous_employment_release', '离职证明'], ['previous_employment_payroll', '上家单位一年工资流水'],
  ['photo', '一寸照片'], ['medical_report', '体检报告'], ['bank_card', '工资卡'], ['other', '其他材料'],
]
const selected = (code: string) => props.modelValue.some((item) => item === code || item.startsWith(code + ':'))
function toggle(code: string, checked: boolean) {
  const next = props.modelValue.filter((item) => item !== code && !item.startsWith(code + ':'))
  emit('update:modelValue', checked ? [...next, code] : next)
}
function details(code: string) {
  return props.modelValue.flatMap((item, index) => item === code || item.startsWith(code + ':')
    ? [{ index, value: item.startsWith(code + ':') ? item.slice(code.length + 1) : '' }] : [])
}
function updateDetail(code: string, index: number, value: string) {
  emit('update:modelValue', props.modelValue.map((item, itemIndex) => itemIndex === index ? code + ':' + value : item))
}
const unknown = computed(() => props.modelValue.filter((item) => !options.some(([code]) => item === code || item.startsWith(code + ':'))))
</script>

<template>
  <fieldset class="offer-materials"><legend>入职材料</legend>
    <div v-for="[code, label] in options" :key="code" class="material-row">
      <label><input type="checkbox" :checked="selected(code)" @change="toggle(code, ($event.target as HTMLInputElement).checked)" />{{ label }}</label>
      <template v-if="code === 'bank_card' || code === 'other'">
        <input v-for="(entry, detailIndex) in details(code)" :key="entry.index" :aria-label="(code === 'bank_card' ? '工资卡银行名称' : '其他入职材料') + (details(code).length > 1 ? ' ' + (detailIndex + 1) : '')" :value="entry.value" maxlength="120" :placeholder="code === 'bank_card' ? '银行名称（可选）' : '请输入材料名称'" @input="updateDetail(code, entry.index, ($event.target as HTMLInputElement).value)" />
      </template>
    </div>
    <label v-for="item in unknown" :key="item"><input type="checkbox" checked @change="emit('update:modelValue', modelValue.filter((value) => value !== item))" />{{ item }}</label>
  </fieldset>
</template>

<style scoped>
.offer-materials { display: grid; gap: 10px; min-width: 0; margin: 0; padding: 12px; border: 1px solid #d8e3dc; border-radius: 6px; }
legend { padding: 0 5px; font-size: 13px; }.material-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
label { display: flex; align-items: center; gap: 7px; font-size: 13px; }input[type=checkbox] { width: 16px; height: 16px; margin: 0; }
.material-row > input { flex: 1 1 180px; min-width: 0; width: 100%; padding: 7px; border: 1px solid #cbd5e1; border-radius: 5px; }
</style>
