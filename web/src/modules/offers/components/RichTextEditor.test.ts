// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import RichTextEditor from './RichTextEditor.vue'
import { bindOfferContent, synchronizeOfferContent } from '../utils/offerContent'

let app: App | undefined
let root: HTMLDivElement | undefined

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
})

describe('RichTextEditor template variables', () => {
  it('keeps every filled reference underlined after editing, serialization and field updates', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    const values = { candidateName: '马良泽', jobTitle: '工程师', supervisorName: '刘凌', supervisorTitle: '负责人', startDate: '2026-11-12', reportingTime: '12:44', reportingLocation: '杭州', probationDuration: '1', probationSalaryMonths: '1', formalSalaryStartMonth: '2', probationSalary: '4000', baseSalary: '8000', payday: '15', invoiceTitle: '123', taxNumber: '123456', benefits: '五险一金', materials: '1. 身份证；\n2. 工资卡；' }
    const template = Object.keys(values).map(key => '<p><strong>{{' + key + '}}</strong></p>').join('') + '<p>普通正文不标记</p>'
    const model = { modelValue: bindOfferContent(template, values) }
    app = createApp(RichTextEditor, model)
    app.mount(root)
    await flush()
    const references = root.querySelectorAll<HTMLElement>('[data-offer-variable]')
    expect(references).toHaveLength(Object.keys(values).length)
    for (const reference of references) {
      expect(reference.style.textDecoration).toBe('underline')
      expect(reference.style.textUnderlineOffset).toBe('3px')
    }
    expect(root.querySelector('.rich-text-content p:last-child [style]')).toBeNull()
    const serialized = root.querySelector('.rich-text-content')!.innerHTML
    const nextValues = { ...values, baseSalary: '9000' }
    const updated = synchronizeOfferContent(serialized, nextValues)
    app.unmount()
    app = createApp(RichTextEditor, { modelValue: updated })
    app.mount(root)
    await flush()
    const salary = root.querySelector<HTMLElement>('[data-offer-variable="baseSalary"]')
    expect(salary?.textContent).toBe('9000')
    expect(salary?.style.textDecoration).toBe('underline')
    expect(root.querySelector('[data-offer-variable="materials"] br')).not.toBeNull()
  })
  it('preserves bound multiline materials and formatting through editor serialization', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    const content = bindOfferContent('<p data-offer-role="onboarding-materials">{{入职材料}}</p><p><strong>{{报到地点}}</strong></p>', { materials: ['1. 身份证', '2. 工资卡'].join(String.fromCharCode(10)), reportingLocation: '旧地址' })
    app = createApp(RichTextEditor, { modelValue: content })
    app.mount(root)
    await flush()
    const serialized = root.querySelector('.rich-text-content')!.innerHTML
    expect(serialized).toContain('data-offer-variable="materials"')
    expect(serialized).toContain('data-offer-role="onboarding-materials"')
    const updated = synchronizeOfferContent(serialized, { materials: '1. 体检报告', reportingLocation: '新地址' })
    expect(new DOMParser().parseFromString(updated, 'text/html').body.textContent).toBe('1. 体检报告新地址')
    expect(updated).toContain('<strong>')
  })
  it('underlines only template variables without changing their text', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(RichTextEditor, {
      modelValue: '<p>{{候选人姓名}} 和 {{岗位名称}}</p><p>这是一段普通正文。</p>',
    })
    app.mount(root)
    await flush()

    const content = root.querySelector('.rich-text-content')
    const variables = content?.querySelectorAll('.template-variable')
    expect(variables).toHaveLength(2)
    expect(Array.from(variables ?? []).map((element) => element.textContent)).toEqual([
      '{{候选人姓名}}',
      '{{岗位名称}}',
    ])
    expect(content?.querySelector('p:last-child .template-variable')).toBeNull()
    expect(content?.textContent).toContain('这是一段普通正文。')
  })
})
