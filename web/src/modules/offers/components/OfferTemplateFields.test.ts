// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import OfferTemplateFields from './OfferTemplateFields.vue'
import { offerTemplateFieldValues, type OfferTemplateFields as TemplateFields } from '../utils/templateFields'

describe('Offer reporting date and time fields', () => {
  let app: App | undefined
  let root: HTMLDivElement | undefined

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = undefined
    root = undefined
  })

  it('selects a date separately and preserves the existing time', async () => {
    const model = ref<TemplateFields>({ reportingTime: '09:30' })
    const Host = defineComponent({
      setup: () => () => h(OfferTemplateFields, {
        modelValue: model.value,
        employmentType: 'full_time',
        'onUpdate:modelValue': (value) => { model.value = value },
      }),
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Host)
    app.mount(root)

    const date = root.querySelector<HTMLInputElement>('#offer-reporting-date')!
    expect(date.type).toBe('date')
    date.value = '2026-11-15'
    date.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(model.value.reportingTime).toBe('2026-11-15T09:30')
    expect(root.querySelector<HTMLInputElement>('#offer-reporting-time')?.value).toBe('09:30')
  })

  it('keeps the date when the date is selected before the time', async () => {
    const model = ref<TemplateFields>({})
    const Host = defineComponent({
      setup: () => () => h(OfferTemplateFields, {
        modelValue: model.value,
        employmentType: 'full_time',
        'onUpdate:modelValue': (value) => { model.value = value },
      }),
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Host)
    app.mount(root)

    const date = root.querySelector<HTMLInputElement>('#offer-reporting-date')!
    date.value = '2026-11-15'
    date.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(model.value.reportingTime).toBe('2026-11-15')

    const time = root.querySelector<HTMLInputElement>('#offer-reporting-time')!
    time.value = '09:30'
    time.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(model.value.reportingTime).toBe('2026-11-15T09:30')
    expect(root.querySelector<HTMLInputElement>('#offer-reporting-date')?.value).toBe('2026-11-15')
    expect(root.querySelector<HTMLInputElement>('#offer-reporting-time')?.value).toBe('09:30')
  })

  it('uses one editable salary month input with automatic defaults and no extra controls', async () => {
    const model = ref<TemplateFields>({ probationDuration: '1' })
    const Host = defineComponent({
      setup: () => () => h(OfferTemplateFields, {
        modelValue: model.value,
        employmentType: 'full_time',
        'onUpdate:modelValue': (value) => { model.value = value },
      }),
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Host)
    app.mount(root)

    expect(root.textContent).not.toContain('试用期薪资适用月数')
    expect(root.querySelector('label[for="offer-formalSalaryStartMonth"]')?.textContent).toBe('调薪起始月')
    const salaryMonth = root.querySelector<HTMLInputElement>('#offer-formalSalaryStartMonth')!
    const salaryField = salaryMonth.closest('.form-field')!
    expect(salaryField.querySelectorAll('input')).toHaveLength(1)
    expect(salaryField.querySelector('input[type="checkbox"], p, [role="alert"]')).toBeNull()
    expect(salaryMonth.value).toBe('2')
    expect(salaryMonth.readOnly).toBe(false)
    expect(offerTemplateFieldValues(model.value).probationSalaryMonths).toBe('1')
    const duration = root.querySelector<HTMLInputElement>('#offer-probationDuration')!
    duration.value = '3个月'
    duration.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(salaryMonth.value).toBe('4')
    expect(offerTemplateFieldValues(model.value).probationSalaryMonths).toBe('3')
    expect(salaryMonth.readOnly).toBe(false)
    salaryMonth.value = '3'
    salaryMonth.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(offerTemplateFieldValues(model.value).probationSalaryMonths).toBe('2')
    duration.value = '6个月'
    duration.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(salaryMonth.value).toBe('3')
    salaryMonth.value = ''
    salaryMonth.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(model.value.formalSalaryStartMonth).toBe('')
    expect(offerTemplateFieldValues(model.value).formalSalaryStartMonth).toBe('7')
    model.value = { probationDuration: '1', formalSalaryStartMonth: '12' }
    await nextTick()
    expect(salaryMonth.value).toBe('12')
    salaryMonth.value = '2'
    salaryMonth.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(model.value.formalSalaryStartMonth).toBe('2')
  })
})
