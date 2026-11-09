export function isHtmlContent(value: string): boolean {
  return /^\s*<(?:p|h[1-6]|ul|ol|li|div|blockquote|strong|em|u|br|a|pre|code)(?:\s|>)/iu.test(value)
}

export function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function inlineMarkdown(value: string): string {
  return escapeHtmlText(value)
    .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/__([^_]+)__/gu, '<strong>$1</strong>')
    .replace(/_([^_]+)_/gu, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu, '<a href="$2">$1</a>')
}

/** Converts the Markdown subset supported by legacy Offer templates into safe editor HTML. */
export function markdownToRichHtml(markdown: string): string {
  const blocks: string[] = []
  let listType: 'ul' | 'ol' | undefined
  let listItems: string[] = []

  const flushList = () => {
    if (!listType || !listItems.length) return
    blocks.push(`<${listType}>${listItems.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</${listType}>`)
    listType = undefined
    listItems = []
  }

  for (const rawLine of markdown.replace(/\r\n?/gu, '\n').split('\n')) {
    const line = rawLine.trim()
    const heading = line.match(/^(#{1,3})\s+(.+)$/u)
    const unordered = line.match(/^[-*]\s+(.+)$/u)
    const ordered = line.match(/^\d+[.)、]\s+(.+)$/u)
    const nextListType = unordered ? 'ul' : ordered ? 'ol' : undefined

    if (nextListType) {
      if (listType && listType !== nextListType) flushList()
      listType = nextListType
      listItems.push((unordered ?? ordered)![1]!)
      continue
    }

    flushList()
    if (!line) continue
    if (heading) {
      const level = heading[1]!.length
      blocks.push(`<h${level}>${inlineMarkdown(heading[2]!)}</h${level}>`)
    } else if (/^(?:[一二三四五六七八九十百]+、|[（(][一二三四五六七八九十百]+[）)])/u.test(line)) {
      blocks.push(`<h2>${inlineMarkdown(line)}</h2>`)
    } else if (/^录用通知书[：:]?$/u.test(line)) {
      blocks.push(`<h1>${inlineMarkdown(line)}</h1>`)
    } else {
      blocks.push(`<p>${inlineMarkdown(line)}</p>`)
    }
  }
  flushList()
  return blocks.join('')
}

export function normalizeRichHtml(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return isHtmlContent(trimmed) ? trimmed : markdownToRichHtml(trimmed)
}

/** 将旧模板中写死的报到地址转换为模板变量。 */
export function normalizeReportingLocationTemplate(value: string): string {
  return value.replace(/杭州市余杭区(?:城投未来之星|未来科技城)\s*C2\s*幢\s*(?:21\s*楼\s*)?2105\s*室/gu, '{{报到地点}}')
}

/** Render reporting-location variables while preserving all other variables. */
export function renderReportingLocation(content: string, reportingLocation: string): string {
  if (!reportingLocation.trim()) return normalizeReportingLocationTemplate(content)
  const value = escapeHtmlText(reportingLocation).replace(/\r?\n/gu, '<br>')
  return normalizeReportingLocationTemplate(content).replace(/\{\{\s*(?:reportingLocation|报到地点|报到地址|报到地点\/房间号)\s*\}\}/gu, value)
}

/** 仅填充发票字段，保留其他模板变量供发送时处理。 */
export function renderOfferInvoiceFields(content: string, fields: { invoiceTitle?: string; taxNumber?: string }): string {
  const values: Record<string, string | undefined> = {
    invoiceTitle: fields.invoiceTitle, '发票抬头': fields.invoiceTitle,
    taxNumber: fields.taxNumber, '企业税号': fields.taxNumber,
  }
  return content.replace(/\{\{\s*(invoiceTitle|发票抬头|taxNumber|企业税号)\s*\}\}/gu, (token, name: string) =>
    values[name]?.trim() ? escapeHtmlText(values[name]!).replace(/\r?\n/gu, '<br>') : token,
  )
}

/** Keeps the candidate greeting as the first block in an Offer email. */
export function pinCandidateGreeting(value: string, candidateName?: string): string {
  const html = normalizeRichHtml(value)
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const body = document.body
  const greeting = [...body.querySelectorAll('p, h1, h2, h3')].find((block) =>
    /\{\{\s*(?:candidateName|\u5019\u9009\u4eba\u59d3\u540d)\s*\}\}/u.test(block.textContent ?? '')
      || Boolean(candidateName?.trim() && block.textContent?.trim().startsWith(candidateName.trim())),
  )
  const firstBlock = greeting ?? document.createElement('p')

  if (!greeting) firstBlock.textContent = '{{candidateName}}\uFF0C\u60A8\u597D\uFF1A'
  firstBlock.setAttribute('data-offer-role', 'candidate-greeting')
  body.insertBefore(firstBlock, body.firstChild)
  return body.innerHTML
}

/** Marks the material variable so email rendering does not indent the inserted checklist. */
function markOnboardingMaterials(value: string, savedMaterials: readonly string[] = []): string {
  const html = normalizeRichHtml(value)
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const blocks = [...document.body.querySelectorAll('p, li, div, ol, ul')]
  const materialVariable = blocks.find((block) =>
    /^\{\{\s*(?:materials|onboardingMaterials|\u5165\u804c\u6750\u6599)\s*\}\}$/u.test(block.textContent?.trim() ?? ''),
  )
  materialVariable?.setAttribute('data-offer-role', 'onboarding-materials')

  if (!materialVariable && savedMaterials.length) {
    const labels: Record<string, string> = {
      graduation_certificate: '毕业证书、学位证书',
      id_card: '身份证',
      previous_employment_release: '上家公司劳动合同解除证明或者离职证明',
      previous_employment_payroll: '上家单位一年工资流水',
      photo: '一寸照片一张',
      medical_report: '体检报告',
    }
    const expected = savedMaterials.map((item) => {
      const [code, ...details] = item.split(':')
      const detail = details.join(':').trim()
      if (code === 'bank_card') return `${detail ? `${detail} ` : ''}工资卡`
      if (code === 'other') return detail
      return labels[code ?? ''] ?? item
    }).filter(Boolean)
    for (const block of blocks) {
      if (!block.matches('p, li, ol, ul')) continue
      const text = (block.textContent ?? '').replace(/^\s*\d+[.)、]\s*/u, '').replace(/[；;。\s]/gu, '')
      if (expected.some((label) => text.includes(label.replace(/[；;。\s]/gu, '')))) {
        block.setAttribute('data-offer-role', 'onboarding-materials')
      }
    }
  }
  return document.body.innerHTML
}

export function pinOfferEmailContent(value: string, candidateName?: string, savedMaterials: readonly string[] = []): string {
  return markOnboardingMaterials(pinCandidateGreeting(value, candidateName), savedMaterials)
}

export function renderHtmlTemplate(content: string, values: Record<string, string | number | undefined>): string {
  const html = normalizeRichHtml(normalizeReportingLocationTemplate(content))
  const aliases: Record<string, string> = {
    '候选人姓名': 'candidateName', '称谓': 'salutation', '岗位名称': 'jobTitle', positionTitle: 'jobTitle',
    '试用期月薪': 'probationSalary', '转正后月薪': 'baseSalary', formalSalary: 'baseSalary',
    '其他福利或约定': 'benefits', '所属部门': 'department',
  }
  const resolved: Record<string, string | number | undefined> = { ...values, salutation: values.salutation ?? '您好' }
  return html.replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (token, name: string) => {
    const key = name.trim()
    const rawValue = Object.hasOwn(resolved, key) ? resolved[key] : resolved[aliases[key] ?? '']
    if (rawValue === undefined) return token
    const value = String(rawValue)
    if (!value.trim()) return token
    return escapeHtmlText(value).replace(/\r?\n/gu, '<br>')
  })
}

export function hasVisibleRichText(value: string): boolean {
  return normalizeRichHtml(value)
    .replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;|&#160;/giu, ' ')
    .trim().length > 0
}
