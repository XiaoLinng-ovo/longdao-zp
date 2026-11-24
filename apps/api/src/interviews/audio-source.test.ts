import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mapAudioSourceRoles, parseAudioSource, type AudioSourceConfig } from './audio-source.js'
import type { SpeakerSegment } from './role-mapper.js'
const segment: SpeakerSegment = { id: 's', speakerId: 'voice_one', text: '我负责开发。', startMs: 0, endMs: 1000, speakerVerified: true }

describe('independent audio provenance and role mapping', () => {
  it('validates explicit source settings without inventing provenance for old uploads', () => {
    assert.equal(parseAudioSource(undefined), undefined)
    assert.deepEqual(parseAudioSource({ id: 'meeting', role: 'candidate', multipleSpeakers: false }), { id: 'meeting', role: 'candidate', multipleSpeakers: false })
    for (const input of [null, [], {}, { id: 'system', role: 'candidate', multipleSpeakers: false }, { id: 'meeting', role: 'candidate' }, { id: 'meeting', role: 'boss', multipleSpeakers: true }]) assert.throws(() => parseAudioSource(input), /INVALID_AUDIO_SOURCE/)
  })
  it('requires explicit single-person confirmation before assigning a whole source', () => {
    const source: AudioSourceConfig = { id: 'microphone', role: 'candidate', multipleSpeakers: false }
    const [row] = mapAudioSourceRoles([{ ...segment, text: '请介绍你的项目？', speakerVerified: false }], source, {}, {})
    assert.equal(row?.role, 'candidate'); assert.equal(row?.audioSource, 'microphone'); assert.equal(row?.speakerId, 'microphone:single')
    assert.equal(row?.confidence, 1)
    assert.equal(mapAudioSourceRoles([{ ...segment, speakerVerified: false }], { ...source, role: 'unknown' }, {}, {})[0]?.role, 'unknown')
  })
  it('never assigns the chosen source role to everyone on a multi-person track', () => {
    const rows = mapAudioSourceRoles([segment, { ...segment, id: 'two', speakerId: 'voice_two', text: '请介绍你的项目？' }], { id: 'meeting', role: 'candidate', multipleSpeakers: true }, {}, {})
    assert.deepEqual(rows.map(row => row.role), ['candidate', 'interviewer'])
    assert.deepEqual(rows.map(row => row.speakerId), ['meeting:voice_one', 'meeting:voice_two'])
    assert.ok(rows.every(row => row.audioSource === 'meeting'))
  })
  it('keeps uncertain recovered stream text tagged but unscored', () => {
    const [row] = mapAudioSourceRoles([{ ...segment, speakerVerified: false, speakerId: 'stream_0' }], { id: 'meeting', role: 'unknown', multipleSpeakers: true }, {}, {})
    assert.equal(row?.role, 'unknown'); assert.equal(row?.audioSource, 'meeting'); assert.ok(row!.confidence < .6)
  })
  it('respects human corrections only within the matching source identity', () => {
    const confirmed = { 'meeting:voice_one': 'interviewer' as const }
    assert.equal(mapAudioSourceRoles([segment], { id: 'meeting', role: 'unknown', multipleSpeakers: true }, confirmed, {})[0]?.role, 'interviewer')
    assert.equal(mapAudioSourceRoles([segment], { id: 'microphone', role: 'unknown', multipleSpeakers: true }, confirmed, {})[0]?.role, 'candidate')
  })
})

