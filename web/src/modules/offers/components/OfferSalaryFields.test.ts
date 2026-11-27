// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import OfferSalaryFields from './OfferSalaryFields.vue'
import { salaryFormError, salaryPayload } from '../utils/salary'
import type { OfferTemplateFields } from '../utils/templateFields'

let app: App, root: HTMLDivElement
afterEach(() => { app?.unmount(); root?.remove() })
describe('Offer salary form', () => {
  it('keeps probation unchanged and derives the second month; switching mode clears the initial amount', async () => {
    const fields = ref<OfferTemplateFields>({ probationDuration: '3个月', probationSalaryMonths: '3', formalSalaryStartMonth: '4' })
    const initial = ref(8000)
    root = document.createElement('div'); document.body.append(root)
    app = createApp(defineComponent({ setup: () => () => h(OfferSalaryFields, { fields: fields.value, employmentType: 'full_time', baseSalary: 10000, initialSalary: initial.value,
      'onUpdate:fields': value => { fields.value = value }, 'onUpdate:initialSalary': value => { initial.value = value } }) }))
    app.mount(root)
    const months = root.querySelector<HTMLInputElement>('#offer-initial-months')!
    months.value = '1'; months.dispatchEvent(new Event('input')); await nextTick()
    expect(fields.value.probationDuration).toBe('3个月')
    expect(fields.value.formalSalaryStartMonth).toBe('2')
    expect(root.textContent).toContain('第 1 个月月薪 8,000 元；第 2 个月起正常月薪 10,000 元')
    root.querySelector<HTMLInputElement>('input[value="regular"]')!.click(); await nextTick()
    expect(initial.value).toBe(0)
    expect(root.querySelector('#offer-initial-salary')).toBeNull()
    expect(salaryPayload('full_time', fields.value, initial.value).probationSalary).toBeNull()
  })
  it('requires review of missing or contradictory legacy timing', () => {
    expect(salaryFormError('full_time', {}, 10000, 8000)).toContain('确认')
    expect(salaryFormError('full_time', { probationSalaryMonths: '1', formalSalaryStartMonth: '4' }, 10000, 8000)).toContain('核对')
    expect(salaryFormError('full_time', { probationSalaryMonths: '0' }, 10000, 0)).toBe('')
    expect(salaryFormError('full_time', { probationSalaryMonths: '0' }, 10000.123, 0)).toContain('两位小数')
  })
})
