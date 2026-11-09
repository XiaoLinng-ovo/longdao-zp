<script setup lang="ts">
import { CalendarDays, ChevronLeft, ChevronRight } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: string
  ariaLabel: string
  disabled?: boolean
}>(), { disabled: false })

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const open = ref(false)

function createLocalDate(year: number, month: number, day = 1): Date {
  return new Date(year, month, day)
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const date = createLocalDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date : null
}

function toValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function displayValue(value: string): string {
  return value ? value.replaceAll('-', '/') : '选择日期'
}

function currentMonth(value: string): Date {
  const selected = parseDate(value)
  const now = new Date()
  return createLocalDate(selected?.getFullYear() ?? now.getFullYear(), selected?.getMonth() ?? now.getMonth())
}

const displayedMonth = ref(currentMonth(props.modelValue))
const monthLabel = computed(() => `${displayedMonth.value.getFullYear()}年${displayedMonth.value.getMonth() + 1}月`)
const selectedValue = computed(() => props.modelValue)
const calendarDays = computed(() => {
  const monthStart = createLocalDate(displayedMonth.value.getFullYear(), displayedMonth.value.getMonth())
  const firstWeekday = (monthStart.getDay() + 6) % 7
  const firstCell = createLocalDate(monthStart.getFullYear(), monthStart.getMonth(), 1 - firstWeekday)
  return Array.from({ length: 42 }, (_, index) => {
    const date = createLocalDate(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate() + index)
    return {
      date,
      value: toValue(date),
      day: date.getDate(),
      outside: date.getMonth() !== displayedMonth.value.getMonth(),
    }
  })
})

function isToday(value: string): boolean {
  return value === toValue(new Date())
}

function toggle() {
  if (props.disabled) return
  open.value = !open.value
  if (open.value) displayedMonth.value = currentMonth(props.modelValue)
}

function previousMonth() {
  displayedMonth.value = createLocalDate(displayedMonth.value.getFullYear(), displayedMonth.value.getMonth() - 1)
}

function nextMonth() {
  displayedMonth.value = createLocalDate(displayedMonth.value.getFullYear(), displayedMonth.value.getMonth() + 1)
}

function selectDate(value: string) {
  emit('update:modelValue', value)
  open.value = false
  void nextTick(() => trigger.value?.focus())
}

function clearDate() {
  emit('update:modelValue', '')
  open.value = false
  void nextTick(() => trigger.value?.focus())
}

function selectToday() {
  selectDate(toValue(new Date()))
}

function closeOnOutsidePointer(event: MouseEvent) {
  if (open.value && root.value && event.target instanceof Node && !root.value.contains(event.target)) open.value = false
}

function closeOnEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !open.value) return
  open.value = false
  trigger.value?.focus()
}

watch(() => props.modelValue, (value) => {
  if (!open.value) displayedMonth.value = currentMonth(value)
})

onMounted(() => {
  document.addEventListener('mousedown', closeOnOutsidePointer)
  document.addEventListener('keydown', closeOnEscape)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', closeOnOutsidePointer)
  document.removeEventListener('keydown', closeOnEscape)
})
</script>

<template>
  <div ref="root" class="calendar-date-picker">
    <button
      ref="trigger"
      class="calendar-date-trigger"
      type="button"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      aria-haspopup="dialog"
      data-date-picker-trigger
      :data-value="modelValue"
      :disabled="disabled"
      @click="toggle"
    >
      <span>{{ displayValue(modelValue) }}</span>
      <CalendarDays :size="15" aria-hidden="true" />
    </button>

    <div v-if="open" class="calendar-date-popover" role="dialog" :aria-label="`${ariaLabel}日历`">
      <div class="calendar-date-header">
        <strong>{{ monthLabel }}</strong>
        <div class="calendar-date-navigation">
          <button type="button" aria-label="上个月" title="上个月" @click="previousMonth"><ChevronLeft :size="17" aria-hidden="true" /></button>
          <button type="button" aria-label="下个月" title="下个月" @click="nextMonth"><ChevronRight :size="17" aria-hidden="true" /></button>
        </div>
      </div>
      <div class="calendar-date-weekdays" aria-hidden="true"><span v-for="day in ['一', '二', '三', '四', '五', '六', '日']" :key="day">{{ day }}</span></div>
      <div class="calendar-date-grid" role="grid" :aria-label="monthLabel">
        <button
          v-for="item in calendarDays"
          :key="item.value"
          type="button"
          role="gridcell"
          class="calendar-date-day"
          :class="{ 'is-outside': item.outside, 'is-selected': item.value === selectedValue, 'is-today': isToday(item.value) }"
          :data-date="item.value"
          :aria-label="`${item.date.getFullYear()}年${item.date.getMonth() + 1}月${item.day}日`"
          :aria-selected="item.value === selectedValue"
          @click="selectDate(item.value)"
        >{{ item.day }}</button>
      </div>
      <div class="calendar-date-footer">
        <button type="button" :disabled="!modelValue" @click="clearDate">清除</button>
        <button type="button" @click="selectToday">今天</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.calendar-date-picker{position:relative;width:100%;z-index:2}
.calendar-date-trigger{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:36px;padding:6px 9px;border:1px solid #cfe0ec;border-radius:7px;background:#ffffffb3;color:#36536a;font:inherit;font-size:12px;line-height:1.4;text-align:left;cursor:pointer}
.calendar-date-trigger:hover{border-color:#9bc5d9;background:#fff}.calendar-date-trigger:focus-visible{outline:2px solid #75b9d3;outline-offset:2px}.calendar-date-trigger:disabled{cursor:not-allowed;opacity:.6}.calendar-date-trigger svg{flex:none;color:#628096}
.calendar-date-popover{position:absolute;top:calc(100% + 8px);left:0;z-index:20;width:282px;padding:12px;border:1px solid #d9e6ef;border-radius:8px;background:#fff;box-shadow:0 14px 28px rgba(45,77,103,.18);color:#1f3547}
.calendar-date-header{display:flex;align-items:center;justify-content:space-between;min-height:28px;padding:0 1px}.calendar-date-header strong{font-size:13px;font-weight:700}.calendar-date-navigation{display:flex;gap:2px}.calendar-date-navigation button{display:grid;place-items:center;width:28px;height:28px;border:0;border-radius:5px;background:transparent;color:#3b566d;cursor:pointer}.calendar-date-navigation button:hover{background:#edf5fa}.calendar-date-navigation button:focus-visible,.calendar-date-footer button:focus-visible,.calendar-date-day:focus-visible{outline:2px solid #75b9d3;outline-offset:1px}
.calendar-date-weekdays,.calendar-date-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));text-align:center}.calendar-date-weekdays{margin-top:10px;color:#73899a;font-size:11px;line-height:28px}.calendar-date-grid{gap:2px}.calendar-date-day{display:grid;place-items:center;aspect-ratio:1;border:0;border-radius:5px;background:transparent;color:#1f3547;font:inherit;font-size:12px;cursor:pointer}.calendar-date-day:hover{background:#e9f4fa;color:#176d86}.calendar-date-day.is-outside{color:#a5b5c0}.calendar-date-day.is-today{box-shadow:inset 0 0 0 1px #65a8c0}.calendar-date-day.is-selected{background:#2f81dd;color:#fff;box-shadow:none}.calendar-date-day.is-selected:hover{background:#216fca;color:#fff}
.calendar-date-footer{display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:9px;border-top:1px solid #e7eef3}.calendar-date-footer button{border:0;background:transparent;color:#287f9a;font:inherit;font-size:12px;cursor:pointer}.calendar-date-footer button:disabled{color:#a8b8c3;cursor:default}
</style>
