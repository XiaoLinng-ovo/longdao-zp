import type { NormalizedSkill } from '../contracts/types.js'

export const NORMALIZER_VERSION = '0.1.0'

const SKILL_ALIASES: Record<string, string> = {
  js: 'javascript',
  'java script': 'javascript',
  ts: 'typescript',
  'type script': 'typescript',
  node: 'node.js',
  nodejs: 'node.js',
  'node js': 'node.js',
  'react.js': 'react',
  reactjs: 'react',
  vuejs: 'vue',
  'vue.js': 'vue',
  postgres: 'postgresql',
  'postgre sql': 'postgresql',
  k8s: 'kubernetes',
}

export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1] !== ''))
    .join('\n')
    .trim()
}

export function normalizeToken(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[^\p{L}\p{N}+#./-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}

export function normalizePhone(value: string): string {
  const trimmed = value.trim()
  const hasPlus = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')
  return hasPlus ? `+${digits}` : digits
}

export function normalizeSkill(value: string): NormalizedSkill {
  const normalized = normalizeToken(value)
  const canonical = SKILL_ALIASES[normalized] ?? normalized
  return {
    value: value.trim(),
    canonical,
    aliases: normalized && normalized !== canonical ? [normalized] : [],
    evidence: [value.trim()],
  }
}

export function normalizeSkillNames(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeSkill(value).canonical).filter(Boolean))]
}

export function tokenize(value: string): string[] {
  return normalizeToken(value).split(/[\s/+#.-]+/).filter(Boolean)
}
