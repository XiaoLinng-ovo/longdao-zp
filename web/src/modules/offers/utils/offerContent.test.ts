// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { bindOfferContent, synchronizeOfferContent, resolvedOfferContent } from './offerContent'

describe('Offer reference synchronization', () => {
  it('underlines every reference in outgoing HTML while keeping bold, line breaks and ordinary prose', () => {
    const values = { candidateName: '马良泽', jobTitle: '工程师', supervisorName: '刘凌', supervisorTitle: '负责人', startDate: '2026-11-12', reportingTime: '12:44', reportingLocation: '杭州', probationDuration: '1', probationSalaryMonths: '1', formalSalaryStartMonth: '2', probationSalary: '4000', baseSalary: '8000', payday: '15', invoiceTitle: '123', taxNumber: '123456', benefits: '五险一金', materials: '1. 身份证；\n2. 工资卡；' }
    const template = Object.keys(values).map(key => '<p><strong>{{' + key + '}}</strong></p>').join('') + '<p>普通正文</p>'
    const html = resolvedOfferContent(bindOfferContent(template, values), values)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(Array.from(doc.querySelectorAll('u')).map(node => node.textContent)).toEqual(Object.values(values).map(value => value.replaceAll('\n', '')))
    expect(doc.querySelectorAll('strong u')).toHaveLength(Object.keys(values).length)
    expect(doc.querySelector('u br')).not.toBeNull()
    expect(doc.querySelector('p:last-child u')).toBeNull()
    expect(html).not.toContain('data-offer-variable')
  })
  it('recovers a stale labeled tax number across inline formatting and keeps unrelated numbers', () => {
    const html = '<p>企业税号：<strong>91330110</strong><u>MADN84UJ22</u>。</p><p>联系电话：18106122955；旧档案：91330110MADN84UJ22。</p>'
    const bound = bindOfferContent(html, { taxNumber: '123456' }, true)
    const updated = synchronizeOfferContent(bound, { taxNumber: '654321' })
    const rendered = resolvedOfferContent(updated, { taxNumber: '654321' })
    const doc = new DOMParser().parseFromString(rendered, 'text/html')
    expect(doc.querySelector('p')?.textContent).toBe('企业税号：654321。')
    expect(doc.body.textContent).toContain('联系电话：18106122955；旧档案：91330110MADN84UJ22。')
    expect(doc.querySelector('p u')?.textContent).toBe('654321')
  })
  it('resolves old tax literals in readonly previews and does not erase a deliberately edited reference', () => {
    expect(resolvedOfferContent('<p>企业税号：91330110MADN84UJ22。</p>', { taxNumber: '123456' })).toContain('<u>123456</u>')
    const bound = bindOfferContent('<p>企业税号：{{企业税号}}。</p>', { taxNumber: '123456' })
    const edited = bound.replace('>123456</span>', '>MANUAL123</span>')
    const updated = synchronizeOfferContent(edited, { taxNumber: '654321' })
    expect(resolvedOfferContent(updated, { taxNumber: '654321' })).toContain('<u>MANUAL123</u>')
  })
  it('does not overwrite unlabeled company numbers or unresolved tax placeholders', () => {
    const rendered = resolvedOfferContent('<p>档案：91330110MADN84UJ22</p><p>企业税号：{{企业税号}}。</p>', { taxNumber: '' })
    expect(rendered).toContain('档案：91330110MADN84UJ22')
    expect(rendered).toContain('{{taxNumber}}')
  })
  it('restores erased legacy salary fields and keeps them bound', () => {
    const legacy = '<p>试用期为 （建议填写 1 至 3 个月）。</p><p>入职前 个月税前薪资为 <strong>元/月</strong>；</p><p>转正后或自第 个月起，税前薪资调整为 <strong>元/月</strong>；</p><p>公司于每月 日发放工资；</p><p><strong>其他福利/约定</strong>：。</p><p>发票抬头为：；</p><p>手写约定保留。</p>'
    const values = { probationDuration: '3个月', probationSalaryMonths: '3', probationSalary: '15000', formalSalaryStartMonth: '4', baseSalary: '18000', payday: '15', benefits: '五险一金', invoiceTitle: '测试公司' }
    const bound = bindOfferContent(legacy, values, true)
    expect(bound).toContain('data-offer-variable="probationSalary"')
    const next = { ...values, probationSalary: '16000', baseSalary: '19000', payday: '16' }
    const rendered = resolvedOfferContent(synchronizeOfferContent(bound, next), next)
    const doc = new DOMParser().parseFromString(rendered, 'text/html')
    expect(doc.body.textContent).toContain('入职前 3个月税前薪资为 16000元/月')
    expect(doc.body.textContent).toContain('转正后或自第 4个月起，税前薪资调整为 19000元/月')
    expect(doc.body.textContent).toContain('公司于每月 16日发放工资')
    expect(doc.body.textContent).toContain('试用期为 3个月')
    expect(doc.body.textContent).toContain('其他福利/约定：五险一金。')
    expect(doc.body.textContent).toContain('发票抬头为：测试公司；')
    expect(doc.body.textContent).toContain('手写约定保留。')
    expect(rendered).not.toContain('data-offer-variable')
  })
  it('keeps missing legacy values visible and preserves manual terms', () => {
    const legacy = '<p>入职前 个月税前薪资为 <strong>元/月</strong>；</p><p>转正后或自第 4 个月起，税前薪资调整为 <strong>25000元/月</strong>；</p><p>公司于每月 20 日发放工资；</p>'
    const rendered = resolvedOfferContent(legacy, { baseSalary: '18000', payday: '15' })
    const text = new DOMParser().parseFromString(rendered, 'text/html').body.textContent
    expect(text).toContain('{{probationSalaryMonths}}')
    expect(text).toContain('{{probationSalary}}')
    expect(text).toContain('25000元/月')
    expect(text).toContain('每月 20 日')
    expect(text).not.toContain('18000')
  })
  it('updates date, location, salary and materials without replacing manual prose', () => {
    const old = { startDate: '2026-11-20', reportingLocation: '原报到地点', baseSalary: '10000', materials: ['1. 身份证；', '2. 体检报告；'].join(String.fromCharCode(10)) }
    const content = bindOfferContent('<p>特别约定保留。</p><p>{{报到日期}} {{报到地点}} {{转正后月薪}}</p><p>{{入职材料}}</p>', old)
    const updated = synchronizeOfferContent(content, { ...old, startDate: '2026-12-01', reportingLocation: '新报到地点', baseSalary: '12000', materials: '1. 工资卡；' })
    const doc = new DOMParser().parseFromString(updated, 'text/html')
    expect(doc.body.textContent).toBe('特别约定保留。2026-12-01 新报到地点 120001. 工资卡；')
    expect(doc.body.textContent).not.toContain('原报到地点')
  })
  it('preserves a manually overridden reference and unrelated paragraphs', () => {
    const html = bindOfferContent('<p>{{报到地点}}</p><p>手工补充</p>', { reportingLocation: '原地址' }).replace('>原地址</span>', '>线下另约</span>')
    const updated = synchronizeOfferContent(html, { reportingLocation: '新地址' })
    expect(updated).toBe('<p>线下另约</p><p>手工补充</p>')
  })
  it('escapes field HTML and preserves multiline materials', () => {
    const html = resolvedOfferContent('<p>{{报到地点}}</p><p>{{入职材料}}</p>', { reportingLocation: '<img src=x onerror=alert(1)>', materials: ['1. 身份证；', '2. 工资卡；'].join(String.fromCharCode(10)) })
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelector('img')).toBeNull()
    expect(doc.querySelectorAll('br')).toHaveLength(1)
    expect(doc.body.textContent).toContain('<img src=x onerror=alert(1)>')
  })
  it('renders referenced values as underlined text in the email body', () => {
    const content = bindOfferContent('<p>职位：{{positionTitle}}</p><p>报到：{{报到日期}}</p>', {
      jobTitle: 'AI 应用工程师', positionTitle: 'AI 应用工程师', startDate: '2026-11-12',
    })
    const rendered = resolvedOfferContent(content, { jobTitle: 'AI 应用工程师', positionTitle: 'AI 应用工程师', startDate: '2026-11-12' })
    const doc = new DOMParser().parseFromString(rendered, 'text/html')
    expect(doc.querySelector('p u')?.textContent).toBe('AI 应用工程师')
    expect(doc.querySelectorAll('u')).toHaveLength(2)
    expect(doc.body.textContent).toContain('2026-11-12')
  })
  it('recovers unique legacy references in the read-only email preview', () => {
    const rendered = resolvedOfferContent('<p>直属上级：数字科技负责人刘凌</p><p>手写补充说明</p>', {
      supervisorName: '数字科技负责人刘凌',
    })
    const doc = new DOMParser().parseFromString(rendered, 'text/html')
    expect(doc.querySelector('u')?.textContent).toBe('数字科技负责人刘凌')
    expect(doc.body.textContent).toContain('手写补充说明')
  })
  it('recovers unique legacy values but never guesses ambiguous numbers', () => {
    const html = bindOfferContent('<p>报到：旧办公地点</p><p>工资8000，奖金8000</p>', { reportingLocation: '旧办公地点', baseSalary: '8000', bonus: '8000' }, true)
    const updated = synchronizeOfferContent(html, { reportingLocation: '新办公地点', baseSalary: '9000', bonus: '5000' })
    expect(updated).toContain('新办公地点')
    expect(updated).toContain('工资8000，奖金8000')
  })
})

