const PAGE_MARKER = /^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/iu
const OPAQUE_TOKEN = /^[a-f0-9]{12,}[A-Za-z0-9_-]{20,}$/u

function watermarkTokens(lines: string[]): Set<string> {
  const counts = new Map<string, number>()
  for (const line of lines) {
    const value = line.trim()
    // Require repeated, isolated, mixed-case identifiers. Do not strip labelled
    // hashes, links, ordinary English skills or one-off project identifiers.
    if (OPAQUE_TOKEN.test(value) && /[A-Z]/u.test(value) && /[a-z]/u.test(value) && /\d/u.test(value)) {
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
  }
  return new Set([...counts].filter(([, count]) => count >= 2).map(([token]) => token))
}

function cleanLines(lines: string[], tokens: Set<string>): string[] {
  const artifact = (line: string) => tokens.has(line.trim()) || PAGE_MARKER.test(line)
  const fragment = (line: string) => /^[ih]$/u.test(line.trim())
  return lines.filter((line, index) => {
    if (artifact(line)) return false
    if (!tokens.size || !fragment(line)) return true
    // Remove isolated watermark fragments only when adjoining an artifact block.
    for (const direction of [-1, 1]) {
      let neighbor = index + direction
      while (neighbor >= 0 && neighbor < lines.length && (!lines[neighbor]!.trim() || fragment(lines[neighbor]!))) neighbor += direction
      if (neighbor >= 0 && neighbor < lines.length && artifact(lines[neighbor]!)) return false
    }
    return true
  })
}

export function cleanResumeText(text: string): string {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  return cleanLines(lines, watermarkTokens(lines)).join('\n')
}

/** Count actual body text, not platform watermarks or isolated glyph debris. */
export function resumeBodyCharacterCount(text: string): number {
  return cleanResumeText(text).split('\n')
    .filter((line) => !OPAQUE_TOKEN.test(line.trim()) && !/^[ih]$/u.test(line.trim()))
    .join('').replace(/[^\p{L}\p{N}]/gu, '').length
}

/** Font decoding failures are not evidence of skills, even in long text. */
export function resumeTextHasEncodingDamage(text: string): boolean {
  const cleaned = cleanResumeText(text)
  const characters = [...cleaned.replace(/\s/gu, '')]
  const damaged = characters.filter((character) => /[\uFFFD\p{Co}\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(character)).length
  const missingGlyphs = cleaned.match(/\(cid:\s*\d+\)/giu)?.length ?? 0
  // Occasional icon-font bullets are harmless; sustained undecodable glyphs
  // or PDF extraction placeholders must be recovered before scoring.
  return (damaged >= 3 && damaged / characters.length >= 0.1) || missingGlyphs >= 3
}

/** Read-only compatibility cleanup for fields saved before text filtering. */
export function cleanResumeFieldValues(values: string[], sourceText = ''): string[] {
  const tokens = new Set([...watermarkTokens(sourceText.replace(/\r\n?/gu, '\n').split('\n')), ...watermarkTokens(values)])
  const cleaned = cleanLines(values, tokens)
  return cleaned.length === values.length ? values : cleaned
}
