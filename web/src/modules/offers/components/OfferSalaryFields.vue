<script setup lang="ts">
import { computed } from 'vue'
import { offerSalarySummary, offerSalaryTiming, offerSalaryTimingIssue } from '@smartrecruit-pro/contracts'
import type { OfferTemplateFields } from '../utils/templateFields'

const props = defineProps<{ fields: OfferTemplateFields; employmentType: string; baseSalary: number; initialSalary: number }>()
const emit = defineEmits<{ 'update:fields': [value: OfferTemplateFields]; 'update:baseSalary': [value: number]; 'update:initialSalary': [value: number] }>()
const timing = computed(() => offerSalaryTiming(props.fields))
const mode = computed(() => timing.value.probationSalaryMonths === '0' ? 'regular' : 'initial')
const issue = computed(() => offerSalaryTimingIssue(props.fields))
const summary = computed(() => offerSalarySummary(props.fields, props.baseSalary, props.initialSalary))
function setMonths(value: string) {
  emit('update:fields', { ...props.fields, probationSalaryMonths: value, formalSalaryStartMonth: value === '' ? '' : String(Number(value) + 1) })
}
function setMode(value: string) {
  setMonths(value === 'regular' ? '0' : (Number(timing.value.probationSalaryMonths) > 0 ? timing.value.probationSalaryMonths : '1'))
  if (value === 'regular') emit('update:initialSalary', 0)
}
</script>

<template>
  <section class="offer-salary-fields" aria-label="试用期与薪资">
    <h4>试用期与薪资</h4>
    <div class="salary-grid">
      <div v-if="employmentType === 'full_time'" class="form-field">
        <label for="offer-probationDuration">试用期时长</label>
        <input id="offer-probationDuration" :value="fields.probationDuration ?? ''" maxlength="50" placeholder="例如：3个月" @input="emit('update:fields', { ...fields, probationDuration: ($event.target as HTMLInputElement).value })" />
      </div>
      <fieldset v-if="employmentType === 'full_time'" class="salary-mode">
        <legend>薪资安排</legend>
        <label><input type="radio" name="offer-salary-mode" value="regular" :checked="mode === 'regular'" @change="setMode('regular')" />入职即正常月薪</label>
        <label><input type="radio" name="offer-salary-mode" value="initial" :checked="mode === 'initial'" @change="setMode('initial')" />初期薪资后调整</label>
      </fieldset>
      <template v-if="employmentType === 'full_time' && mode === 'initial'">
        <div class="form-field"><label for="offer-initial-salary">初期月薪（元/月）</label><input id="offer-initial-salary" type="number" min="0.01" step="0.01" :value="initialSalary" @input="emit('update:initialSalary', Number(($event.target as HTMLInputElement).value))" /></div>
        <div class="form-field"><label for="offer-initial-months">初期薪资适用月数</label><input id="offer-initial-months" type="number" min="1" max="12" step="1" :value="timing.probationSalaryMonths" @input="setMonths(($event.target as HTMLInputElement).value)" /></div>
      </template>
      <div class="form-field"><label for="offer-normal-salary">{{ employmentType === 'internship' ? '实习工资（元/月）' : '正常月薪（元/月）' }}</label><input id="offer-normal-salary" type="number" min="0.01" step="0.01" :value="baseSalary" @input="emit('update:baseSalary', Number(($event.target as HTMLInputElement).value))" /></div>
      <div v-if="employmentType === 'full_time'" class="form-field"><label>正常月薪起始月</label><output>{{ timing.formalSalaryStartMonth ? `入职第 ${timing.formalSalaryStartMonth} 个月` : '待确认' }}</output></div>
    </div>
    <p v-if="employmentType === 'full_time'" class="salary-summary" :class="{ 'salary-warning': issue }" :role="issue ? 'alert' : 'status'">{{ summary }}</p>
  </section>
</template>

<style scoped>
.offer-salary-fields{grid-column:1 / -1;min-width:0;border-block:1px solid var(--border,#dbe3ef);padding-block:16px}
h4{margin:0 0 12px;font-size:14px}
.salary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.salary-mode{min-width:0;margin:0;padding:0;border:0;display:flex;flex-wrap:wrap;align-content:center;gap:10px}
.salary-mode legend{font-size:12px;color:var(--muted);margin-bottom:8px}
.salary-mode label{display:flex;align-items:center;gap:6px;font-size:13px}
.salary-mode input{width:16px;height:16px;margin:0;flex:none}
output{display:flex;align-items:center;min-height:40px;font-size:14px}
.salary-summary{margin:12px 0 0;line-height:1.6;font-size:13px;color:#286044;overflow-wrap:anywhere}
.salary-warning{color:#a34c15}
@media(max-width:560px){.salary-grid{grid-template-columns:minmax(0,1fr)}}
</style>
