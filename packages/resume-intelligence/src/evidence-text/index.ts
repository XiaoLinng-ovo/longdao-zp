/** Only affirmative resume clauses can support a requirement. A negated list
 * remains negated until a sentence/line boundary, not merely its first item. */
const NEGATION = /未(?:掌握|涉及|修读|学习|接触|使用|具备|从事)|(?:尚)?缺乏|缺少|暂无|尚无|不(?:掌握|熟悉|具备|会|擅长|涉及)|没有(?:相关)?(?:经验|接触|掌握|使用)|无(?:相关)?(?:经验|基础)|\b(?:not familiar with|no experience (?:in|with)|never used|do not know|don't know)\b/iu

export function positiveEvidenceText(text: string): string {
  return text.split(/[\n。；;!?！？]|但是|但|然而|不过|\bhowever\b/iu).map((clause) => {
    const negative = clause.match(NEGATION)
    if (!negative || negative.index === undefined) return clause
    // Suffix denials cover the whole preceding list, including every comma.
    if (/缺乏|缺少|暂无|尚无/u.test(negative[0])) return ''
    const before = clause.slice(0, negative.index)
    // A suffix such as “Python 不熟悉” negates the preceding item too.
    if (/^(?:不|未掌握)/u.test(negative[0]) && before.trim() && !/[：:,，]\s*$/u.test(before)) {
      const separator = Math.max(before.lastIndexOf('，'), before.lastIndexOf(','))
      return separator >= 0 ? before.slice(0, separator) : ''
    }
    return before
  }).filter(Boolean).join('\n')
}
