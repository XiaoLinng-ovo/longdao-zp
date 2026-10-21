import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingInterviewAudio } from './pending-audio'
import { createStreamingTranscriptBuffer } from './streaming-transcript'

const chunk = (id = 'chunk-1', offsetMs = 0): PendingInterviewAudio => ({ id, scope: 'tenant:user:interview', sessionId: 'session', audio: new Blob(['audio']), contentType: 'audio/webm', offsetMs, endMs: offsetMs + 15000 })
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('streaming transcript checkpoints', () => {
  it('normalizes partial and final scripts before preview and checkpoint comparison', async () => {
    const view = vi.fn()
    const buffer = createStreamingTranscriptBuffer(view, vi.fn())
    buffer.partial('對於我在學校的項目，使用 Python 和 RAG。')
    expect(view).toHaveBeenLastCalledWith('对于我在学校的项目，使用 Python 和 RAG。')
    const audio = chunk()
    const done = buffer.commit(audio, true)
    buffer.final('对于我在学校的项目，使用 Python 和 RAG。', audio.id)
    await done
    expect(audio.streamingTranscript).toEqual({ text: '对于我在学校的项目，使用 Python 和 RAG。', endMs: 15000, complete: true })
    buffer.acknowledge(audio.id)
    buffer.partial('然後提交發票。')
    const second = chunk('second', 15000)
    const secondDone = buffer.commit(second, true)
    buffer.final('然後提交發票。', second.id)
    await secondDone
    expect(second.streamingTranscript?.text).toBe('然后提交发票。')
    expect(second.streamingTranscript?.complete).toBe(true)
  })
  it('preserves all preview words when a nonempty final is truncated', async () => {
    const buffer = createStreamingTranscriptBuffer(vi.fn(), vi.fn())
    buffer.partial('每个切片之间保留重叠，然后检索切片，再进行重排序。')
    const audio = chunk()
    const done = buffer.commit(audio, true)
    buffer.final('每个切片之间保留重叠。', audio.id)
    await done
    expect(audio.streamingTranscript?.text).toBe('每个切片之间保留重叠，然后检索切片，再进行重排序。')
    expect(audio.streamingTranscript?.complete).toBe(false)
  })

  it('does not erase active or committed preview words on a shorter partial', async () => {
    const buffer = createStreamingTranscriptBuffer(vi.fn(), vi.fn())
    buffer.partial('完整的项目介绍和实现过程')
    buffer.partial('完整的项目介绍')
    const audio = chunk()
    const done = buffer.commit(audio, true)
    buffer.partial('项目介绍')
    buffer.final('完整的项目介绍和实现过程。', audio.id)
    await done
    expect(audio.streamingTranscript?.text).toBe('完整的项目介绍和实现过程。')
    expect(audio.streamingTranscript?.complete).toBe(true)
  })

  it('pairs the final with its audio and retains text until that exact chunk is saved', async () => {
    const view = vi.fn()
    const buffer = createStreamingTranscriptBuffer(view, vi.fn())
    buffer.partial('请介绍你的项目')
    const first = chunk()
    let ready = false
    const done = buffer.commit(first, true).then(() => { ready = true })
    expect(first.streamingTranscript?.text).toBe('请介绍你的项目')
    await Promise.resolve(); expect(ready).toBe(false)
    buffer.partial('请介绍你的项目和职责。')
    buffer.final('请介绍你的项目和职责。', first.id)
    await done
    expect(first.streamingTranscript).toEqual({ text: '请介绍你的项目和职责。', endMs: 15000, complete: true })
    buffer.partial('我负责系统开发。')
    buffer.acknowledge('not-this-chunk')
    expect(view).toHaveBeenLastCalledWith('请介绍你的项目和职责。 我负责系统开发。')
    buffer.acknowledge(first.id)
    expect(view).toHaveBeenLastCalledWith('我负责系统开发。')
  })

  it('does not mix a late earlier final into the next recording window', async () => {
    const buffer = createStreamingTranscriptBuffer(vi.fn(), vi.fn())
    buffer.partial('项目问题')
    const first = chunk('first'), second = chunk('second', 15000)
    const firstReady = buffer.commit(first, true), secondReady = buffer.commit(second, true)
    buffer.partial('项目问题完整尾句')
    buffer.final('项目问题完整尾句', 'first')
    await firstReady
    buffer.partial('是否要回学校？')
    buffer.final('错误的迟到结果', 'first')
    expect(second.streamingTranscript?.text).toBe('是否要回学校？')
    buffer.final('是否要回学校？', 'second')
    await secondReady
    expect(first.streamingTranscript?.text).toBe('项目问题完整尾句')
    expect(second.streamingTranscript?.text).toBe('是否要回学校？')
  })

  it('keeps a visible partial after disconnect and stores it with the next audio flush', async () => {
    const buffer = createStreamingTranscriptBuffer(vi.fn(), vi.fn())
    buffer.partial('连接断开前已经识别的完整内容')
    buffer.disconnect()
    const audio = chunk()
    await buffer.commit(audio, false)
    expect(audio.streamingTranscript?.text).toBe('连接断开前已经识别的完整内容')
    expect(audio.streamingTranscript?.complete).toBe(false)
  })

  it('times out without deleting words or blocking the upload queue indefinitely', async () => {
    let buffer: ReturnType<typeof createStreamingTranscriptBuffer>
    const timeout = vi.fn(() => buffer.disconnect())
    buffer = createStreamingTranscriptBuffer(vi.fn(), timeout)
    buffer.partial('暂时没有收到尾句确认的内容')
    const audio = chunk()
    const done = buffer.commit(audio, true)
    await vi.advanceTimersByTimeAsync(5000)
    await done
    expect(timeout).toHaveBeenCalledOnce()
    expect(audio.streamingTranscript?.text).toBe('暂时没有收到尾句确认的内容')
    expect(audio.streamingTranscript?.complete).toBe(false)
  })

  it('does not erase nonempty partials on an empty final frame', async () => {
    const buffer = createStreamingTranscriptBuffer(vi.fn(), vi.fn())
    buffer.partial('不能被空结果清除')
    const audio = chunk()
    const done = buffer.commit(audio, true)
    buffer.final('', audio.id)
    await done
    expect(audio.streamingTranscript?.text).toBe('不能被空结果清除')
    expect(audio.streamingTranscript?.complete).toBe(false)
  })

  it('does not claim complete coverage after a reconnect with no earlier partial', async () => {
    const buffer = createStreamingTranscriptBuffer(vi.fn(), vi.fn())
    buffer.disconnect()
    buffer.partial('Only the speech after reconnection')
    const audio = chunk()
    const done = buffer.commit(audio, true)
    buffer.final('Only the speech after reconnection', audio.id)
    await done
    expect(audio.streamingTranscript?.complete).toBe(false)
  })
})
