import type { ApiOfferVersion } from '../api'
import { offerSalaryVariables } from '@smartrecruit-pro/contracts'
import { employmentTypeLabel } from '../../../shared/utils/labels'
import { offerTemplateFieldValues } from './templateFields'
import { normalizeRichHtml, renderHtmlTemplate } from './richText'

const aliases: Record<string, string> = {
  '初期月薪': 'initialSalary', '正常月薪': 'normalSalary', '薪资安排说明': 'salaryArrangement',
  '初期薪资适用月数': 'probationSalaryMonths', '正常月薪起始月': 'formalSalaryStartMonth',
  '候选人姓名': 'candidateName', '称谓': 'salutation', '岗位名称': 'jobTitle', positionTitle: 'jobTitle',
  '试用期月薪': 'probationSalary', '试用期工资': 'probationSalary', '转正后月薪': 'baseSalary', '转正后工资': 'baseSalary', formalSalary: 'baseSalary',
  '其他福利或约定': 'benefits', '所属部门': 'department', '用工类型': 'employmentType',
  '报到地点': 'reportingLocation', '报到地址': 'reportingLocation', '报到地点/房间号': 'reportingLocation',
  '发票抬头': 'invoiceTitle', '企业税号': 'taxNumber', '报到日期': 'startDate', reportDate: 'startDate', reportingDate: 'startDate',
  '报到时间': 'reportingTime', '直属上级姓名': 'supervisorName', '直属上级职务': 'supervisorTitle',
  '试用期时长': 'probationDuration', '转正后薪资生效月份': 'formalSalaryStartMonth', '调薪起始月（入职第几个月）': 'formalSalaryStartMonth', '发薪日': 'payday',
  '试用期薪资适用月数': 'probationSalaryMonths', '入职材料': 'materials', onboardingMaterials: 'materials',
  '其他入职材料': 'otherOnboardingMaterials', '工资卡银行名称': 'bankName', '照片数量': 'photoQuantity',
}
export const canonicalOfferVariable = (key: string): string => aliases[key] ?? key
export type OfferValues = Record<string, string | number | undefined>

export function offerContentValues(version: ApiOfferVersion, candidateName = '', department = ''): Record<string, string> {
  const labels: Record<string, string> = { graduation_certificate: '毕业证书、学位证书', id_card: '身份证', previous_employment_release: '上家公司劳动合同解除证明或者离职证明', previous_employment_payroll: '上家单位一年工资流水', photo: '一寸照片一张', medical_report: '体检报告', bank_card: '工资卡' }
  const materialLabels = version.materials.map(item => {
    const [code = '', ...parts] = item.split(':')
    const detail = parts.join(':').trim()
    return code === 'other' ? detail : code === 'bank_card' && detail ? detail + '工资卡' : labels[code] ?? item
  })
  const date = version.templateFields?.reportingTime?.includes('T') ? version.templateFields.reportingTime.slice(0, 10) : version.startDate ?? ''
  const values = {
    ...offerSalaryVariables(version.templateFields ?? {}, version.compensation.baseSalary.amount, version.compensation.probationSalary?.amount),
    ...offerTemplateFieldValues(version.templateFields), candidateName, salutation: '您好', jobTitle: version.positionTitle,
    department, employmentType: employmentTypeLabel(version.employmentType), startDate: date, reportDate: date, '报到日期': date,
    reportingLocation: version.reportingLocation ?? '', invoiceTitle: version.invoiceTitle ?? '', taxNumber: version.taxNumber ?? '',
    baseSalary: String(version.compensation.baseSalary.amount), probationSalary: String(version.compensation.probationSalary?.amount ?? ''),
    bonus: String(version.compensation.bonus?.amount ?? ''), equity: version.compensation.equity ?? '', benefits: version.benefits.join('，'),
    materials: materialLabels.map((label, index) => String(index + 1) + '. ' + label + '；').join('\n'),
    otherOnboardingMaterials: materialLabels.join('、'), bankName: version.materials.find(item => item.startsWith('bank_card:'))?.slice(10) ?? '',
    photoQuantity: version.materials.includes('photo') ? '1' : '', companyName: '',
  }
  return { ...values, ...Object.fromEntries(Object.entries(aliases).map(([alias, key]) => [alias, (values as Record<string, string>)[key] ?? ''])) }
}

function referenceText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement
  clone.querySelectorAll('br').forEach(br => br.replaceWith(clone.ownerDocument.createTextNode('\n')))
  return clone.textContent ?? ''
}

function setReferenceText(element: HTMLElement, value: string) {
  element.replaceChildren()
  value.split('\n').forEach((line, index) => {
    if (index) element.append(element.ownerDocument.createElement('br'))
    element.append(element.ownerDocument.createTextNode(line))
  })
}

function textNodes(body: HTMLElement): Text[] {
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

// Older saved bodies erased unfilled variables. Recover only recognizable empty
// slots, using text offsets so inline bold/underline formatting remains intact.
function restoreEmptyLegacyFields(body: HTMLElement) {
  const slots: [RegExp, string][] = [
    [/(入职前\s*)(?=个月税前薪资为)/gu, 'probationSalaryMonths'],
    [/(个月税前薪资为\s*)(?=元\/月)/gu, 'probationSalary'],
    [/(转正后或自第\s*)(?=个月起)/gu, 'formalSalaryStartMonth'],
    [/(税前薪资调整为\s*)(?=元\/月)/gu, 'baseSalary'],
    [/(公司于每月\s*)(?=日发放工资)/gu, 'payday'],
    [/(试用期为\s*)(?=[（(。；])/gu, 'probationDuration'],
    [/(其他福利\/约定[：:]\s*)(?=[。；])/gu, 'benefits'],
    [/(发票抬头为[：:]\s*)(?=[；;。]|$)/gu, 'invoiceTitle'],
  ]
  for (const block of body.querySelectorAll<HTMLElement>('p, li, div')) {
    if (block.querySelector('p, li, div')) continue
    const text = block.textContent ?? ''
    const insertions = slots.flatMap(([pattern, key]) => [...text.matchAll(pattern)].map(match => ({ offset: match.index + match[1]!.length, key })))
    for (const { offset, key } of insertions.sort((a, b) => b.offset - a.offset)) {
      let remaining = offset
      for (const node of textNodes(block)) {
        if (remaining > node.length) { remaining -= node.length; continue }
        if (!node.parentElement?.closest('[data-offer-variable]')) {
          const suffix = node.splitText(remaining)
          suffix.before(body.ownerDocument.createTextNode('{{' + key + '}}'))
        }
        break
      }
    }
  }
}

// Recover the value only after an explicit tax-number label, never by replacing
// matching digits elsewhere (phone numbers, reimbursement amounts, etc.).
function restoreLegacyTaxNumber(body: HTMLElement) {
  for (const block of body.querySelectorAll<HTMLElement>('p, li, div')) {
    if (block.querySelector('p, li, div')) continue
    const matches = [...(block.textContent ?? '').matchAll(/(?:企业税号|纳税人识别号|统一社会信用代码)[：:]\s*([A-Za-z0-9-]+)(?=[\s。；;，,）)]|$)/gu)]
    for (const match of matches.reverse()) {
      const start = match.index + match[0].length - match[1]!.length
      const end = start + match[1]!.length
      const range = body.ownerDocument.createRange()
      let offset = 0
      let protectedValue = false
      for (const node of textNodes(block)) {
        const next = offset + node.length
        if (next > start && offset < end) {
          if (node.parentElement?.closest('[data-offer-variable]')) protectedValue = true
          if (offset <= start) range.setStart(node, start - offset)
          if (next >= end) { range.setEnd(node, end - offset); break }
        }
        offset = next
      }
      if (protectedValue) continue
      const span = body.ownerDocument.createElement('span')
      span.dataset.offerVariable = 'taxNumber'
      span.dataset.offerOriginal = match[1]!
      span.append(range.extractContents())
      range.insertNode(span)
    }
  }
}

/** Reference marks survive rich-text edits; unrelated manual prose remains untouched. */
export function bindOfferContent(content: string, values: OfferValues, recoverLegacy = false): string {
  const doc = new DOMParser().parseFromString(normalizeRichHtml(content), 'text/html')
  restoreEmptyLegacyFields(doc.body)
  if (recoverLegacy && Object.hasOwn(values, 'taxNumber')) restoreLegacyTaxNumber(doc.body)
  for (const node of textNodes(doc.body)) {
    if (node.parentElement?.closest('[data-offer-variable]')) continue
    const matches = [...(node.textContent ?? '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}/gu)]
    if (!matches.length) continue
    const fragment = doc.createDocumentFragment()
    let offset = 0
    for (const match of matches) {
      fragment.append((node.textContent ?? '').slice(offset, match.index))
      const key = canonicalOfferVariable(match[1]!.trim())
      const value = String(values[key] ?? values[match[1]!.trim()] ?? '')
      const span = doc.createElement('span')
      span.dataset.offerVariable = key
      span.dataset.offerOriginal = value.trim() ? value : match[0]
      setReferenceText(span, span.dataset.offerOriginal)
      fragment.append(span)
      offset = match.index + match[0].length
    }
    fragment.append((node.textContent ?? '').slice(offset))
    node.replaceWith(fragment)
  }
  if (recoverLegacy) {
    const unique = Object.fromEntries(Object.entries(values).filter(([key]) => canonicalOfferVariable(key) === key))
    for (const [key, raw] of Object.entries(unique)) {
      const value = String(raw ?? '')
      if (value.length < 4 || Object.entries(unique).some(([other, otherValue]) => other !== key && String(otherValue) === value)) continue
      const nodes = textNodes(doc.body).filter(node => !node.parentElement?.closest('[data-offer-variable]') && node.textContent?.includes(value))
      if (nodes.length !== 1) continue
      const node = nodes[0]!
      if (node.textContent!.split(value).length !== 2) continue
      // Bare numbers are recoverable only when they occupy a complete text node.
      if (/^\d+(?:\.\d+)?$/u.test(value) && node.textContent?.trim() !== value) continue
      const [before = '', after = ''] = node.textContent!.split(value)
      const span = doc.createElement('span')
      span.dataset.offerVariable = key
      span.dataset.offerOriginal = value
      span.textContent = value
      node.replaceWith(doc.createTextNode(before), span, doc.createTextNode(after))
    }
  }
  return doc.body.innerHTML
}

export function synchronizeOfferContent(content: string, values: OfferValues): string {
  const doc = new DOMParser().parseFromString(bindOfferContent(content, values), 'text/html')
  for (const span of doc.body.querySelectorAll<HTMLElement>('[data-offer-variable]')) {
    if (referenceText(span) !== span.dataset.offerOriginal) {
      // Keep the original marker for a manually overridden tax reference so
      // label-based legacy recovery cannot bind it again on the next preview.
      if (span.dataset.offerVariable !== 'taxNumber') span.replaceWith(...span.childNodes)
      continue
    }
    const value = String(values[span.dataset.offerVariable ?? ''] ?? '')
    const rendered = value.trim() ? value : '{{' + span.dataset.offerVariable + '}}'
    setReferenceText(span, rendered)
    span.dataset.offerOriginal = rendered
  }
  return doc.body.innerHTML
}

export function resolvedOfferContent(content: string, values: OfferValues): string {
  const boundContent = bindOfferContent(content, values, true)
  const doc = new DOMParser().parseFromString(synchronizeOfferContent(boundContent, values), 'text/html')
  doc.querySelectorAll<HTMLElement>('[data-offer-variable]').forEach(span => {
    const underline = doc.createElement('u')
    underline.append(...span.childNodes)
    span.replaceWith(underline)
  })
  return renderHtmlTemplate(doc.body.innerHTML, values)
}

