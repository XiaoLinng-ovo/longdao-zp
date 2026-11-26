import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export function normalizeTranscript(value) {
  if (typeof value !== 'string') throw new Error('Transcript must be a string')
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')
}

export function characterDistance(reference, hypothesis) {
  const a = Array.from(reference), b = Array.from(hypothesis)
  if (a.length > 5000 || b.length > 5000) throw new Error('Split samples into segments of at most 5000 characters')
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j-1]+1, previous[j]+1, previous[j-1]+(a[i-1] === b[j-1] ? 0 : 1))
    previous = current
  }
  return previous[b.length]
}

export function evaluateTranscriptSamples(samples) {
  if (!Array.isArray(samples) || !samples.length) throw new Error('Provide a non-empty sample array')
  const results = samples.map((sample, index) => {
    if (!sample || typeof sample !== 'object') throw new Error('Invalid sample at index ' + index)
    const reference = normalizeTranscript(sample.reference), hypothesis = normalizeTranscript(sample.hypothesis)
    const referenceCharacters = Array.from(reference).length
    if (!referenceCharacters) throw new Error('Reference must contain spoken text at index ' + index)
    const errors = characterDistance(reference, hypothesis)
    return { id: sample.id ?? index + 1, referenceCharacters, errors, cer: errors / referenceCharacters }
  })
  const referenceCharacters = results.reduce((n, row) => n + row.referenceCharacters, 0)
  const errors = results.reduce((n, row) => n + row.errors, 0)
  return { samples: results.length, referenceCharacters, errors, cer: errors / referenceCharacters, results }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const input = process.argv.indexOf('--input'), limit = process.argv.indexOf('--max-cer')
    if (input < 0 || !process.argv[input+1]) throw new Error('Usage: node scripts/evaluate-transcription.mjs --input samples.json [--max-cer 0.15]')
    const threshold = limit < 0 ? undefined : Number(process.argv[limit+1])
    if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0)) throw new Error('Invalid CER threshold')
    const result = evaluateTranscriptSamples(JSON.parse(await readFile(resolve(process.argv[input+1]), 'utf8')))
    console.log(JSON.stringify({ ...result, ...(threshold === undefined ? {} : { threshold, passed: result.cer <= threshold }) }, null, 2))
    if (threshold !== undefined && result.cer > threshold) process.exitCode = 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
