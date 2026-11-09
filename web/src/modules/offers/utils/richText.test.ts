// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { hasVisibleRichText, markdownToRichHtml, normalizeRichHtml, normalizeReportingLocationTemplate, pinCandidateGreeting, pinOfferEmailContent, renderHtmlTemplate, renderOfferInvoiceFields, renderReportingLocation } from './richText'

it('renders invoice fields safely without consuming other template variables', () => {
  expect(renderOfferInvoiceFields('<p>{{ 发票抬头 }} / {{invoiceTitle}} / {{企业税号}} / {{taxNumber}} / {{candidateName}}</p>', {
    invoiceTitle: '测试<公司>&', taxNumber: 'TEST9133',
  })).toBe('<p>测试&lt;公司&gt;&amp; / 测试&lt;公司&gt;&amp; / TEST9133 / TEST9133 / {{candidateName}}</p>')
  expect(renderOfferInvoiceFields('{{发票抬头}}/{{企业税号}}', {})).toBe('{{发票抬头}}/{{企业税号}}')
})

describe('Offer rich text', () => {
  it('preserves empty manual values so sending can require completion', () => {
    expect(renderHtmlTemplate('<p>{{报到地点}} {{报到时间}} {{企业税号}}</p>', {
      '报到地点': '', '报到时间': ' ', '企业税号': '',
    })).toBe('<p>{{报到地点}} {{报到时间}} {{企业税号}}</p>')
    expect(renderReportingLocation('{{报到地点}}', '')).toBe('{{报到地点}}')
  })
  it('converts the supported legacy Markdown template into editor HTML', () => {
    const html = markdownToRichHtml([
      '录用通知书：',
      '',
      '非常荣幸地通知您，**欢迎加入**。',
      '',
      '二、薪酬福利及其他',
      '',
      '- 试用期工资',
      '- 转正后工资',
    ].join('\n'))

    expect(html).toContain('<h1>录用通知书：</h1>')
    expect(html).toContain('<p>非常荣幸地通知您，<strong>欢迎加入</strong>。</p>')
    expect(html).toContain('<h2>二、薪酬福利及其他</h2>')
    expect(html).toContain('<ul><li>试用期工资</li><li>转正后工资</li></ul>')
  })

  it('keeps rich HTML and normalizes plain text', () => {
    expect(normalizeRichHtml('<h1>Offer</h1><p>正文</p>')).toBe('<h1>Offer</h1><p>正文</p>')
    expect(normalizeRichHtml('普通正文')).toBe('<p>普通正文</p>')
  })

  it('pins the candidate greeting to the top without duplicating it', () => {
    const pinned = pinCandidateGreeting('<h1>Offer 录用通知</h1><p>正文</p><p>{{候选人姓名}}：</p>')
    expect(pinned.indexOf('{{候选人姓名}}')).toBeLessThan(pinned.indexOf('Offer 录用通知'))
    expect(pinned.match(/\{\{候选人姓名\}\}/gu)).toHaveLength(1)
  })

  it('adds a candidate greeting when the template has no candidate variable', () => {
    expect(pinCandidateGreeting('<p>正文</p>')).toMatch(/^<p data-offer-role="candidate-greeting">\{\{candidateName\}\}，您好：<\/p><p>正文<\/p>$/u)
  })

  it('keeps the onboarding-material section in the template order', () => {
    const pinned = pinOfferEmailContent([
      '<h1>录用通知书</h1>',
      '<p>候选人：{{候选人姓名}}，您好：</p>',
      '<p>录用正文介绍。</p>',
      '<h2>一、办理入职手续需提供的材料</h2>',
      '<p>{{入职材料}}</p>',
      '<p>请确保所提供资料真实、完整、有效。</p>',
      '<h2>二、薪酬福利及其他</h2>',
      '<p>薪酬正文。</p>',
    ].join(''))

    expect(pinned.indexOf('{{候选人姓名}}')).toBeLessThan(pinned.indexOf('录用通知书'))
    expect(pinned.indexOf('录用通知书')).toBeLessThan(pinned.indexOf('一、办理入职手续需提供的材料'))
    expect(pinned.indexOf('{{入职材料}}')).toBeLessThan(pinned.indexOf('请确保所提供资料真实'))
    expect(pinned.indexOf('录用正文介绍')).toBeLessThan(pinned.indexOf('一、办理入职手续需提供的材料'))
    expect(pinned.indexOf('二、薪酬福利及其他')).toBeLessThan(pinned.indexOf('薪酬正文'))
    expect(pinned).toContain('<p data-offer-role="candidate-greeting">候选人：{{候选人姓名}}，您好：</p>')
    expect(pinned).toContain('<p data-offer-role="onboarding-materials">{{入职材料}}</p>')
  })

  it('keeps the material marker when variables are rendered after layout processing', () => {
    const structured = pinOfferEmailContent('<h1>录用通知书</h1><p>{{候选人姓名}}：</p><p>录用正文介绍。</p><h2>一、入职材料</h2><p>{{入职材料}}</p>')
    const rendered = renderHtmlTemplate(structured, { '候选人姓名': '张明', '入职材料': '1. 身份证；\n2. 工资卡；' })
    expect(rendered).toContain('<p data-offer-role="onboarding-materials">1. 身份证；<br>2. 工资卡；</p>')
    expect(rendered.indexOf('录用正文介绍')).toBeLessThan(rendered.indexOf('一、入职材料'))
  })

  it('marks saved material paragraphs without relying on a section heading', () => {
    const pinned = pinOfferEmailContent('<p>录用正文介绍。</p><p>1. 身份证；</p><p>请按时办理报到。</p>', undefined, ['id_card'])
    expect(pinned).toContain('<p data-offer-role="onboarding-materials">1. 身份证；</p>')
    expect(pinned).not.toContain('<p data-offer-role="onboarding-materials">请按时办理报到。</p>')
  })

  it('recognizes an already-rendered candidate greeting without adding a duplicate', () => {
    const pinned = pinOfferEmailContent('<h1>录用通知书</h1><p>张明，您好：</p><p>正文。</p>', '张明')
    expect(pinned.match(/张明，您好：/gu)).toHaveLength(1)
    expect(pinned).not.toContain('{{candidateName}}')
  })

  it('fills variables as escaped text while preserving template markup', () => {
    const html = renderHtmlTemplate('<h1>{{title}}</h1><p>{{candidateName}}<br>{{note}}</p>', {
      title: '录用通知书',
      candidateName: '<script>alert(1)</script>',
      note: '第一行\n第二行',
    })

    expect(html).toContain('<h1>录用通知书</h1>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('第一行<br>第二行')
  })

  it('maps Chinese offer variables and preserves fields requiring manual completion', () => {
    expect(renderHtmlTemplate('<p>{{候选人姓名}}{{称谓}} {{岗位名称}} {{试用期月薪}} {{转正后月薪}} {{其他福利或约定}} {{直属上级姓名}}</p>', {
      candidateName: '张明', jobTitle: '开发工程师', probationSalary: 10000, baseSalary: 12000, benefits: '五险一金',
    })).toBe('<p>张明您好 开发工程师 10000 12000 五险一金 {{直属上级姓名}}</p>')
  })

  it('renders report date and time independently from the check-in date', () => {
    expect(renderHtmlTemplate('<p>{{报到日期}} {{报到时间}} / {{startDate}}</p>', {
      '报到日期': '2026-11-15', '报到时间': '09:30', startDate: '2026-11-20',
    })).toBe('<p>2026-11-15 09:30 / 2026-11-20</p>')
  })

  it('replaces a legacy fixed address and renders saved reporting location only', () => {
    const legacy = '<p>请前往杭州市余杭区城投未来之星C2幢21楼2105室办理报到。</p>'
    expect(renderHtmlTemplate(normalizeReportingLocationTemplate(legacy), { '报到地点': '滨江区江陵路88号A座1201' })).toContain('滨江区江陵路88号A座1201')
    const rendered = renderReportingLocation('<p>{{候选人姓名}}前往杭州市余杭区城投未来之星 C2 幢 21 楼 2105 室。</p>', '滨江区江陵路88号A座1201')
    expect(rendered).toContain('{{候选人姓名}}')
    expect(rendered).toContain('滨江区江陵路88号A座1201')
    expect(rendered).not.toContain('杭州市余杭区')
  })

  it('treats empty rich-text markup as empty content', () => {
    expect(hasVisibleRichText('<p><br></p>')).toBe(false)
    expect(hasVisibleRichText('<p>&nbsp;</p>')).toBe(false)
    expect(hasVisibleRichText('<h2>薪酬福利</h2>')).toBe(true)
  })
})
