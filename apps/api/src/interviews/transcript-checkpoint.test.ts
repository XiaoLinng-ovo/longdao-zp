import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { reconcileTranscript } from './transcript-checkpoint.js'
import type { SpeakerSegment } from './role-mapper.js'

const sentence = (text: string, startMs = 0): SpeakerSegment => ({ id: `s-${startMs}`, speakerId: 'voice_1', text, startMs, endMs: startMs + 1000, speakerVerified: true })
const checkpoint = { text: '您好，请介绍一下你的项目经历和主要工作。', endMs: 30000, complete: true }

describe('streaming transcript preservation', () => {
  it('keeps offline extra sentences despite a small particle difference in an unfinished preview', () => {
    const rows = [sentence('我负责平台开发。团队一共八个人。我还承担测试和上线工作。')]
    const result = reconcileTranscript(rows, { text: '我负责平台的开发。', endMs: 15000, complete: false }, 0)
    assert.equal(result.map(row => row.text).join(''), rows[0]!.text)
    assert.equal(result[0]?.speakerVerified, true)
    assert.equal(result[0]?.transcriptComparison?.streamingText, '我负责平台的开发。')
    assert.equal(result[0]?.transcriptComparison?.selectedSource, 'offline')
    assert.equal(result[0]?.transcriptComparison?.streamingComplete, false)
    assert.equal(rows[0]?.transcriptComparison, undefined)
  })
  it('preserves conflicting recognition as a separate alternative, never duplicate speech', () => {
    const offline = '我负责平台开发和测试。', streaming = '我负责平台开发。团队一共有八个人。'
    const result = reconcileTranscript([sentence(offline)], { text: streaming, endMs: 15000, complete: true }, 0)
    assert.equal(result.map(row => row.text).join(''), streaming)
    assert.equal(result[0]?.transcriptComparison?.offlineText, offline)
    assert.equal(result[0]?.transcriptComparison?.selectedSource, 'streaming')
    assert.equal(result[0]?.speakerVerified, false)
  })
  for (const [offline, streaming] of [
    ['我负责平台开发。后来完成了上线。', '我不负责平台的开发。'],
    ['我负责二个平台开发。后来完成了上线。', '我负责三个平台的开发。'],
    ['团队成员是李明。后来完成了上线。', '团队成员是李鸣。'],
    ['测试然后开发最后上线。后来完成了交付。', '开发然后测试最后上线。'],
    ['好的。我负责开发和测试。', '好啊。'],
  ]) it(`does not fuzzy-replace meaningful differences: ${streaming}`, () => {
    const result = reconcileTranscript([sentence(offline!)], { text: streaming!, endMs: 15000, complete: false }, 0)
    assert.equal(result.map(row => row.text).join(''), streaming)
    assert.equal(result[0]?.transcriptComparison?.offlineText, offline)
    assert.equal(result[0]?.speakerMixed, true)
  })
  it('aligns Traditional preview with Simplified acoustic turns without losing speakers', () => {
    const rows = [sentence('请介绍学校项目。'), { ...sentence('我负责开发。', 1000), speakerId: 'voice_2' }]
    const result = reconcileTranscript(rows, { text: '請介紹學校項目。我負責開發。', endMs: 15000, complete: true }, 0)
    assert.equal(result, rows)
    assert.equal(result[1]?.speakerVerified, true)
  })
  it('normalizes offline-only and stream-only paths without mutating their inputs', () => {
    const row = sentence('學校項目。')
    assert.deepEqual(reconcileTranscript([row], undefined, 0), [{ ...row, text: '学校项目。' }])
    assert.equal(row.text, '學校項目。')
    const saved = { text: '然後提交發票。', endMs: 30000, complete: false }
    assert.equal(reconcileTranscript([], saved, 15000)[0]?.text, '然后提交发票。')
    assert.equal(saved.text, '然後提交發票。')
  })
  it('replaces one-character offline fragments with the complete streaming text', () => {
    const rows = reconcileTranscript([{ ...sentence('好。'), speakerVerified: false }], checkpoint, 15000)
    assert.equal(rows[0]?.text, checkpoint.text)
    assert.equal(rows[0]?.speakerVerified, false)
    assert.equal(rows[0]?.speakerMixed, true)
    assert.deepEqual([rows[0]?.startMs, rows[0]?.endMs], [0, 15000])
  })
  it('also preserves missing clauses when offline output is not empty', () => {
    const original = sentence('您好，请介绍一下。')
    const rows = reconcileTranscript([original], checkpoint, 15000)
    assert.equal(rows[0], original)
    assert.equal(rows.map(row => row.text.replace(/[，。]/gu, '')).join(''), checkpoint.text.replace(/[，。]/gu, ''))
    assert.equal(rows[1]?.speakerVerified, false)
    assert.equal(rows[1]?.speakerMixed, true)
  })
  it('retains both acoustic speakers and appends only the missing streaming tail', () => {
    const rows = [sentence('请介绍项目。'), { ...sentence('我负责开发。', 1000), speakerId: 'voice_2' }]
    const result = reconcileTranscript(rows, { text: '请介绍项目。我负责开发。也承担测试。', endMs: 15000, complete: true }, 0)
    assert.deepEqual(result.slice(0, 2), rows)
    assert.equal(result[2]?.text, '也承担测试。')
    assert.equal(result[2]?.speakerVerified, false)
  })
  it('keeps one complete stream instead of duplicating recognition disagreements', () => {
    const rows = [sentence('我负责平台开发。')]
    const result = reconcileTranscript(rows, { text: '我负责平台的开发。', endMs: 15000, complete: true }, 0)
    assert.deepEqual(result.map(row => row.text), ['我负责平台的开发。'])
    assert.equal(result[0]?.speakerVerified, false)
  })
  it('does not interleave two divergent versions of the same audio', () => {
    const rows = [sentence('我负责平台开发和测试。')]
    const result = reconcileTranscript(rows, { text: '我负责平台开发。团队一共有八个人。', endMs: 15000, complete: true }, 0)
    assert.deepEqual(result.map(row => row.text), ['我负责平台开发。团队一共有八个人。'])
    assert.equal(result[0]?.speakerMixed, true)
  })
  it('does not attach a verified role to unrelated streaming words', () => {
    const row = sentence('好。')
    const result = reconcileTranscript([row], checkpoint, 15000)
    assert.equal(result[0]?.text, checkpoint.text)
    assert.equal(result[0]?.speakerVerified, false)
  })
  it('retains verified speaker boundaries when all words survive punctuation changes', () => {
    const rows = [sentence('您好。请介绍一下你的项目经历，'), sentence('和主要工作。', 1000)]
    assert.equal(reconcileTranscript(rows, checkpoint, 15000), rows)
  })
  it('keeps the stream when offline returns no sentences at all', () => {
    assert.equal(reconcileTranscript([], checkpoint, 15000)[0]?.text, checkpoint.text)
  })
  it('does not discard a longer offline transcript for an unfinished shorter stream', () => {
    const rows = [sentence('我负责平台开发，还负责数据管理和测试。')]
    assert.equal(reconcileTranscript(rows, { text: '我负责平台开发', endMs: 15000, complete: false }, 0), rows)
  })
  it('continues to support recordings without streaming and never duplicates a covered preview', () => {
    const rows = [sentence(`开始。${checkpoint.text}结束。`)]
    assert.equal(reconcileTranscript(rows, undefined, 0), rows)
    assert.equal(reconcileTranscript(rows, checkpoint, 0), rows)
  })

  it('keeps prefix, middle and tail in order after both API and UI timestamp sorting', () => {
    const first = sentence('先检索切片。', 3000)
    const second = sentence('然后重排序。', 9000)
    const text = '每个切片有重叠。先检索切片。比较相关性。然后重排序。最后生成答案。'
    const result = reconcileTranscript([second, first], { text, endMs: 30000, complete: true }, 15000)
    const sorted = [...result].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    assert.equal(sorted.map(row => row.text).join(''), text)
    assert.deepEqual(sorted.map(row => [row.startMs, row.endMs]), [[0, 3000], [3000, 4000], [4000, 9000], [9000, 10000], [10000, 15000]])
    assert.equal(result[1], first)
    assert.equal(result[3], second)
    assert.ok(result.filter(row => row !== first && row !== second).every(row => row.speakerMixed && !row.speakerVerified))
  })

  it('retains missing stream words even when unfinished offline output has more characters', () => {
    const text = '切片之间保留重叠，再进行检索和重排序。'
    const result = reconcileTranscript([sentence('然后我负责项目的开发测试以及其他一些平台的维护工作。')], { text, endMs: 15000, complete: false }, 0)
    assert.equal(result.map(row => row.text).join(''), text)
    assert.equal(result[0]?.speakerMixed, true)
  })

  it('keeps full text as one unconfirmed chunk when no acoustic interval exists for a missing prefix', () => {
    const text = '前面的背景说明，继续介绍项目。'
    const result = reconcileTranscript([sentence('继续介绍项目。')], { text, endMs: 15000, complete: true }, 0)
    assert.equal(result.length, 1)
    assert.equal(result[0]?.text, text)
    assert.deepEqual([result[0]?.startMs, result[0]?.endMs], [0, 15000])
    assert.equal(result[0]?.speakerVerified, false)
  })

  it('does not split comma-separated streaming speech into tiny rows', () => {
    const text = '然后检索切片，比较相关性，再重排序，最后生成答案。'
    const result = reconcileTranscript([], { text, endMs: 15000, complete: true }, 0)
    assert.deepEqual(result.map(row => row.text), [text])
  })

  it('removes overlapping full-text alternatives instead of returning duplicate words', () => {
    const text = '请介绍项目。我负责开发。'
    const result = reconcileTranscript([sentence('请介绍项目。'), { ...sentence(text), endMs: 15000, speakerMixed: true }], { text, endMs: 15000, complete: true }, 0)
    assert.deepEqual(result.map(row => row.text), [text])
  })
})
