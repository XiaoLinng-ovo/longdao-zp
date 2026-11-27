import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const characters = text => [...text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase()]

export function characterErrors(expected, actual) {
  const a = characters(expected), b = characters(actual)
  const costs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = 0; i <= a.length; i++) costs[i][0] = i
  for (let j = 0; j <= b.length; j++) costs[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    costs[i][j] = Math.min(costs[i - 1][j] + 1, costs[i][j - 1] + 1,
      costs[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]))
  }
  let i = a.length, j = b.length
  const errors = []
  while (i || j) {
    if (i && j && a[i - 1] === b[j - 1] && costs[i][j] === costs[i - 1][j - 1]) { i--; j-- }
    else if (i && j && costs[i][j] === costs[i - 1][j - 1] + 1) {
      errors.push({ type: 'substitution', expected: a[--i], actual: b[--j], expectedIndex: i })
    } else if (i && costs[i][j] === costs[i - 1][j] + 1) {
      errors.push({ type: 'deletion', expected: a[--i], expectedIndex: i })
    } else errors.push({ type: 'insertion', actual: b[--j], expectedIndex: i })
  }
  return { expectedCharacters: a.length, actualCharacters: b.length, edits: errors.length,
    characterErrorRate: a.length ? errors.length / a.length : null,
    deletions: errors.filter(row => row.type === 'deletion').length,
    insertions: errors.filter(row => row.type === 'insertion').length,
    substitutions: errors.filter(row => row.type === 'substitution').length, errors: errors.reverse() }
}

// Source-role correspondence is ground truth of this controlled fixture, not a product rule.
export function fixtureMetrics(fixture, segments) {
  const sources = ['microphone', 'meeting'].map(source => {
    const expectedRole = source === 'microphone' ? 'interviewer' : 'candidate'
    const rows = segments.filter(row => (row.audioSource ?? row.audio_source) === source)
      .sort((a, b) => (a.startMs ?? a.start_ms) - (b.startMs ?? b.start_ms) || (a.endMs ?? a.end_ms) - (b.endMs ?? b.end_ms))
    const expected = fixture.filter(row => row.role === expectedRole).map(row => row.text).join('')
    const actual = rows.map(row => row.text).join('')
    return { source, expectedRole, expected, actual, ...characterErrors(expected, actual),
      segments: rows.length, correctRole: rows.filter(row => row.role === expectedRole).length,
      wrongRole: rows.filter(row => row.role !== expectedRole && row.role !== 'unknown').length,
      unresolved: rows.filter(row => row.role === 'unknown').map(row => ({ text: row.text, id: row.id, review: row.roleReview ?? row.role_review })) }
  })
  const expectedCharacters = sources.reduce((sum, row) => sum + row.expectedCharacters, 0)
  const edits = sources.reduce((sum, row) => sum + row.edits, 0)
  return { normalization: 'NFKC, lowercase, punctuation and whitespace ignored; fillers retained', sources,
    total: { expectedCharacters, edits, characterErrorRate: expectedCharacters ? edits / expectedCharacters : null,
      deletions: sources.reduce((n, row) => n + row.deletions, 0),
      substitutions: sources.reduce((n, row) => n + row.substitutions, 0),
      insertions: sources.reduce((n, row) => n + row.insertions, 0),
      correctRole: sources.reduce((n, row) => n + row.correctRole, 0),
      wrongRole: sources.reduce((n, row) => n + row.wrongRole, 0),
      unresolved: sources.reduce((n, row) => n + row.unresolved.length, 0) } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2])
  const filename = process.argv[3] ?? 'browser-segments.json'
  const fixture = JSON.parse(await readFile(join(directory, 'timeline.json'), 'utf8'))
  const input = JSON.parse(await readFile(join(directory, filename), 'utf8'))
  let segments = input.turns ?? input
  if (input.summary_report?.transcript) {
    const raw = JSON.parse(await readFile(join(directory, 'browser-segments.json'), 'utf8'))
    const sources = new Map(raw.map(row => ['turn-live-' + row.id, row.audio_source]))
    segments = input.summary_report.transcript.map(row => {
      const source = [...new Set(row.segmentIds.map(id => sources.get(id)).filter(Boolean))]
      if (source.length !== 1) throw new Error('Cannot establish source of summary turn ' + row.id)
      return { ...row, audioSource: source[0] }
    })
  }
  const metrics = fixtureMetrics(fixture, segments)
  const output = join(directory, filename.replace(/\.json$/u, '') + '-metrics.json')
  await writeFile(output, JSON.stringify(metrics, null, 2))
  console.log(JSON.stringify({ output, total: metrics.total, sources: metrics.sources }, null, 2))
}
