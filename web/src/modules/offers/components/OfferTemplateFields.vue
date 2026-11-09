<script setup lang="ts">
import { offerTemplateFieldDefinitions, type OfferTemplateFields } from '../utils/templateFields'

const props = defineProps<{ modelValue: OfferTemplateFields; employmentType: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: OfferTemplateFields] }>()
function update(key: keyof OfferTemplateFields, event: Event) {
  emit('update:modelValue', { ...props.modelValue, [key]: (event.target as HTMLInputElement).value })
}
function updateReportingPart(part: 'date' | 'time', event: Event) {
  const saved = props.modelValue.reportingTime ?? ''
  const [currentDate, currentTime] = saved.includes('T')
    ? saved.split('T')
    : /^\d{4}-\d{2}-\d{2}$/u.test(saved)
      ? [saved, '']
      : ['', saved]
  const value = (event.target as HTMLInputElement).value
  const date = part === 'date' ? value : currentDate
  const time = part === 'time' ? value : currentTime
  emit('update:modelValue', { ...props.modelValue, reportingTime: date && time ? `${date}T${time}` : date || time })
}
</script>

<template>
  <template v-for="field in offerTemplateFieldDefinitions" :key="field.key">
    <div v-if="employmentType === 'full_time' || !['probationDuration', 'probationSalaryMonths', 'formalSalaryStartMonth'].includes(field.key)" class="form-field">
      <label :for="`offer-${field.key}`">{{ field.label }}</label>
      <div v-if="field.key === 'reportingTime'" class="reporting-datetime-inputs">
        <input id="offer-reporting-date" aria-label="报到日期" type="date" :value="/^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(modelValue.reportingTime ?? '') ? (modelValue.reportingTime ?? '').split('T')[0] : ''" @input="updateReportingPart('date', $event)" />
        <input id="offer-reporting-time" aria-label="报到时刻" type="time" :value="(modelValue.reportingTime ?? '').includes('T') ? (modelValue.reportingTime ?? '').split('T')[1] : /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(modelValue.reportingTime ?? '') ? modelValue.reportingTime : ''" @input="updateReportingPart('time', $event)" />
      </div>
      <input v-else :id="`offer-${field.key}`" :value="modelValue[field.key] ?? ''" :type="field.type" :maxlength="field.maxLength"
        :min="'min' in field ? field.min : undefined" :max="'max' in field ? field.max : undefined" :step="field.type === 'number' ? 1 : undefined"
        :placeholder="field.key === 'probationDuration' ? '例如：3个月' : `请输入${field.label}`" @input="update(field.key, $event)" />
    </div>
  </template>
</template>

<style scoped>
.reporting-datetime-inputs { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(120px, 1fr); gap: 8px; }
</style>
