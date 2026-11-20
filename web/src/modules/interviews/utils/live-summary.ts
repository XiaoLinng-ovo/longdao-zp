import type { LiveAnswerAnalysis, LiveInterviewSegment } from '../api'
import type { ActualInterviewPair, TranscriptTurn } from '../api/summary'

export interface LiveDialoguePair extends ActualInterviewPair {
  analyses: LiveAnswerAnalysis[]
}

/** Match the summary's conservative pairing: never cross uncertain or overlapping speech. */
export function buildLiveSummary(segments: LiveInterviewSegment[], analyses: Record<string, LiveAnswerAnalysis> = {}) {
  const transcript: TranscriptTurn[] = []
  const rows = [...segments].filter(row => row.text.trim()).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id))
  for (const row of rows) {
    const role = row.role !== 'unknown' && row.confidence >= .6 ? row.role : 'unknown'
    const previous = transcript.at(-1)
    if (previous && previous.role === role && role !== 'unknown' && row.startMs >= previous.endMs && row.startMs - previous.endMs <= 2000) {
      previous.text += `\n${row.text.trim()}`
      previous.segmentIds.push(row.id)
      previous.endMs = Math.max(previous.endMs, row.endMs)
    } else transcript.push({ id: row.id, segmentIds: [row.id], role, text: row.text.trim(), startMs: row.startMs, endMs: row.endMs })
  }
  const analysisById = new Map(rows.filter(row => row.role === 'candidate' && row.confidence >= .6)
    .map(row => [row.id, analyses[row.id] ?? row.analysis]))
  const analysesFor = (ids: string[]) => [...new Set(ids.map(id => analysisById.get(id)).filter((value): value is LiveAnswerAnalysis => Boolean(value)))]
  const pairs: LiveDialoguePair[] = []
  for (let index = 0; index < transcript.length; index++) {
    const turn = transcript[index]!
    if (turn.role !== 'interviewer') continue
    const next = transcript[index + 1]
    const answers: TranscriptTurn[] = []
    if (next?.role === 'candidate' && next.startMs >= turn.endMs) {
      for (let offset = index + 1; offset < transcript.length && transcript[offset]!.role === 'candidate'; offset++) answers.push(transcript[offset]!)
    }
    const answerSegmentIds = answers.flatMap(answer => answer.segmentIds)
    pairs.push({ id: turn.id, question: turn.text, answer: answers.map(answer => answer.text).join('\n'),
      questionSegmentIds: turn.segmentIds, answerSegmentIds, startMs: turn.startMs, endMs: answers.at(-1)?.endMs ?? turn.endMs,
      kind: 'unreviewed', analyses: analysesFor(answerSegmentIds) })
  }
  const paired = new Set(pairs.flatMap(pair => pair.answerSegmentIds))
  const unpaired = transcript.filter(turn => turn.role !== 'interviewer' && !turn.segmentIds.some(id => paired.has(id)))
    .map(turn => ({ ...turn, analyses: turn.role === 'candidate' ? analysesFor(turn.segmentIds) : [] }))
  return { pairs, unpaired, analysesFor }
}
