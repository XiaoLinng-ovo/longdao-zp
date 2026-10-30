import type { AnonymizationReplacement, AnonymizedText, AnonymizeOptions } from '../contracts/types.js'

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const PHONE_RE = /(?:\+?\d[\d ()-]{7,}\d)/g
const URL_RE = /https?:\/\/[^\s]+/gi

interface MatchCandidate {
  kind: AnonymizationReplacement['kind']
  start: number
  end: number
  token: string
}

function collectMatches(text: string, options: AnonymizeOptions): MatchCandidate[] {
  const matches: MatchCandidate[] = []
  const collect = (regex: RegExp, kind: AnonymizationReplacement['kind'], token: string) => {
    for (const match of text.matchAll(regex)) {
      const value = match[0]
      const start = match.index ?? 0
      matches.push({ kind, start, end: start + value.length, token })
    }
  }

  collect(EMAIL_RE, 'email', '[EMAIL]')
  collect(PHONE_RE, 'phone', '[PHONE]')
  if (options.replaceUrls !== false) collect(URL_RE, 'url', '[URL]')
  if (options.replaceNames && options.name?.trim()) {
    const compact = options.name.trim().replace(/\s+/gu, '')
    if (/^\p{Script=Han}{2,4}$/u.test(compact)) {
      collect(new RegExp([...compact].join('[ \\t\\u3000]*'), 'gu'), 'name', '[NAME]')
      return matches
    }
    let offset = 0
    const name = options.name.trim()
    while (offset < text.length) {
      const found = text.toLocaleLowerCase('en-US').indexOf(name.toLocaleLowerCase('en-US'), offset)
      if (found < 0) break
      matches.push({ kind: 'name', start: found, end: found + name.length, token: '[NAME]' })
      offset = found + name.length
    }
  }
  return matches
}

export function anonymizeText(text: string, options: AnonymizeOptions = {}): AnonymizedText {
  const candidates = collectMatches(text, options)
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((candidate, index, values) => index === 0 || candidate.start >= values[index - 1].end)

  let output = ''
  let cursor = 0
  const replacements: AnonymizationReplacement[] = []
  for (const candidate of candidates) {
    output += text.slice(cursor, candidate.start)
    output += candidate.token
    replacements.push({
      kind: candidate.kind,
      token: candidate.token,
      start: candidate.start,
      end: candidate.end,
      originalLength: candidate.end - candidate.start,
    })
    cursor = candidate.end
  }
  output += text.slice(cursor)
  return { text: output, replacements }
}
