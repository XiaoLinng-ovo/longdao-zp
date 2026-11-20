import type { CorrectedTranscriptTurn } from './transcript-postprocessing.js'

export type ManualTranscriptRole = Pick<CorrectedTranscriptTurn, 'id' | 'text' | 'startMs' | 'endMs' | 'audioSource' | 'role'>
export function applyManualTranscriptRoles(turns: CorrectedTranscriptTurn[], roles: ManualTranscriptRole[]): CorrectedTranscriptTurn[] {
  return turns.map(turn => {
    // Changed boundaries or text need fresh review; a speaker ID alone is insufficient.
    const saved = [...roles].reverse().find(row => row.id === turn.id && row.text === turn.text && row.startMs === turn.startMs
      && row.endMs === turn.endMs && row.audioSource === turn.audioSource && (row.role === 'candidate' || row.role === 'interviewer'))
    return saved ? { ...turn, role: saved.role, confidence: 1, speakerConfirmed: true } : turn
  })
}
