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

  it('keeps only the formal salary effective month as an editable salary timing field', () => {
    const model = ref<TemplateFields>({ formalSalaryStartMonth: '4' })
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
    expect(root.textContent).toContain('转正后薪资生效月份')
    expect(root.querySelector<HTMLInputElement>('#offer-formalSalaryStartMonth')?.value).toBe('4')
    expect(offerTemplateFieldValues(model.value)['试用期薪资适用月数']).toBe('3')
    expect(offerTemplateFieldValues({ formalSalaryStartMonth: '4', probationSalaryMonths: '2' })['试用期薪资适用月数']).toBe('2')
  })
})
