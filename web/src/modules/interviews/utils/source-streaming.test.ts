// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createSourceStreaming } from './source-streaming'
import type { PendingInterviewAudio } from './pending-audio'

const channels: ReturnType<typeof createSourceStreaming>[] = []
afterEach(() => { channels.forEach(channel => channel.dispose()); channels.length = 0; vi.unstubAllGlobals() })

async function workletHarness() {
  class Socket extends EventTarget {
    static OPEN = 1; static CLOSING = 2; static instance: Socket
    readyState = 0; bufferedAmount = 0
    onmessage?: (event: { data: string }) => void
    send = vi.fn(); close() { this.readyState = 3 }
    constructor() { super(); Socket.instance = this }
  }
  const port = { postMessage: vi.fn(), onmessage: undefined as ((event: { data: unknown }) => void) | undefined }
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 0 } })
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('AudioWorkletNode', class { port = port; connect = vi.fn(); disconnect = vi.fn() })
  vi.stubGlobal('AudioContext', class {
    state = 'running'; sampleRate = 16000; destination = {}; audioWorklet = { addModule: vi.fn(async () => undefined) }
    resume = vi.fn(async () => undefined); close = vi.fn(async () => undefined)
    createMediaStreamSource = node; createGain = node
  })
  const channel = createSourceStreaming({ isRecording: () => true, onState: vi.fn(), onText: vi.fn(), onWarning: vi.fn() })
  channels.push(channel); channel.start({} as MediaStream)
  const socket = Socket.instance
  socket.readyState = Socket.OPEN; socket.dispatchEvent(new Event('open'))
  for (let i = 0; i < 10; i++) await Promise.resolve()
  socket.onmessage!({ data: JSON.stringify({ type: 'status', status: 'ready' }) })
  return { channel, socket, port, pcm: () => port.onmessage!({ data: { type: 'pcm', samples: new Float32Array(160) } }) }
}

it('sends the worklet tail before commit and next-chunk PCM after commit even when recording resumes immediately', async () => {
  const { channel, socket, port, pcm } = await workletHarness()
  pcm(); channel.pause()
  const id = port.postMessage.mock.calls.at(-1)![0].id
  const chunk: PendingInterviewAudio = { id: 'chunk-1', scope: 'test', sessionId: 'session', audio: new Blob(), contentType: 'audio/webm', offsetMs: 0, endMs: 15000 }
  const done = channel.commit(chunk)
  await channel.resume()
  pcm()
  expect(socket.send.mock.calls.map(row => typeof row[0])).toEqual(['object', 'object'])
  port.onmessage!({ data: { type: 'boundary', id } })
  await Promise.resolve()
  pcm()
  expect(socket.send.mock.calls.map(row => typeof row[0])).toEqual(['object', 'object', 'string', 'object'])
  expect(JSON.parse(socket.send.mock.calls[2]![0])).toEqual({ type: 'commit', commitId: chunk.id })
  socket.onmessage!({ data: JSON.stringify({ type: 'final', text: '尾句已保留', commitId: chunk.id }) })
  await done
  expect(chunk.streamingTranscript?.text).toBe('尾句已保留')
})

it('cancels a pending worklet commit on disconnect without sending it to the replacement socket', async () => {
  const { channel, socket, port } = await workletHarness()
  channel.pause()
  const id = port.postMessage.mock.calls.at(-1)![0].id
  const chunk: PendingInterviewAudio = { id: 'chunk-1', scope: 'test', sessionId: 'session', audio: new Blob(), contentType: 'audio/webm', offsetMs: 0, endMs: 15000 }
  const done = channel.commit(chunk)
  channel.stop()
  await done; await Promise.resolve()
  expect(port.onmessage).toBeNull()
  expect(socket.send).not.toHaveBeenCalled()
  expect(id).toBeTypeOf('number')
})

it('does not resume PCM when a ready frame arrives between stopping one chunk and starting the next', async () => {
  class Socket extends EventTarget {
    static OPEN = 1; static CLOSING = 2
    static instance: Socket
    readyState = 0; bufferedAmount = 0
    onmessage?: (event: { data: string }) => void
    send = vi.fn(); close() { this.readyState = 3 }
    constructor() { super(); Socket.instance = this }
  }
  const processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: undefined as ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | undefined }
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 0 } })
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('AudioContext', class {
    state = 'running'; sampleRate = 16000; destination = {}
    resume = vi.fn(async () => undefined); close = vi.fn(async () => undefined)
    createMediaStreamSource = node; createGain = node; createScriptProcessor = () => processor
  })
  const channel = createSourceStreaming({ isRecording: () => true, onState: vi.fn(), onText: vi.fn(), onWarning: vi.fn() })
  channels.push(channel)
  channel.start({} as MediaStream)
  Socket.instance.readyState = Socket.OPEN; Socket.instance.dispatchEvent(new Event('open'))
  for (let i = 0; i < 5; i++) await Promise.resolve()
  expect(processor.onaudioprocess).toBeTypeOf('function')
  const pcm = () => processor.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(160) } })
  channel.pause()
  Socket.instance.onmessage!({ data: JSON.stringify({ type: 'status', status: 'ready' }) })
  pcm()
  expect(Socket.instance.send).not.toHaveBeenCalled()
  await channel.resume(); pcm()
  expect(Socket.instance.send).toHaveBeenCalledOnce()
  expect(Socket.instance.send.mock.calls[0]![0]).toBeInstanceOf(ArrayBuffer)
  channel.pause(); pcm()
  expect(Socket.instance.send).toHaveBeenCalledOnce()
})

it.each([
  { inputRate: 48000, blocks: [480, 480] },
  { inputRate: 48000, blocks: [128, 128, 128, 128, 128, 128, 128, 128] },
  { inputRate: 44100, blocks: [127, 256, 1024, 31, 441] },
])('keeps resampling phase at $inputRate Hz across $blocks', async ({ inputRate, blocks }) => {
  class Socket extends EventTarget {
    static OPEN = 1; static CLOSING = 2
    static instance: Socket
    readyState = 0; bufferedAmount = 0
    onmessage?: (event: { data: string }) => void
    sent: ArrayBuffer[] = []
    send = vi.fn((value: ArrayBuffer) => { this.sent.push(value) })
    close() { this.readyState = 3 }
    constructor() { super(); Socket.instance = this }
  }
  const processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: undefined as ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | undefined }
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 0 } })
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('AudioContext', class {
    state = 'running'; sampleRate = inputRate; destination = {}
    resume = vi.fn(async () => undefined); close = vi.fn(async () => undefined)
    createMediaStreamSource = node; createGain = node; createScriptProcessor = () => processor
  })
  const channel = createSourceStreaming({ isRecording: () => true, onState: vi.fn(), onText: vi.fn(), onWarning: vi.fn() })
  channels.push(channel)
  channel.start({} as MediaStream)
  Socket.instance.readyState = Socket.OPEN; Socket.instance.dispatchEvent(new Event('open'))
  for (let i = 0; i < 5; i++) await Promise.resolve()
  expect(processor.onaudioprocess).toBeTypeOf('function')
  const sendPcm = (length: number) => processor.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(length) } })
  Socket.instance.onmessage!({ data: JSON.stringify({ type: 'status', status: 'ready' }) })
  blocks.forEach(sendPcm)
  const sampleCount = Socket.instance.sent.reduce((total, bytes) => total + bytes.byteLength / 2, 0)
  const expected = blocks.reduce((total, length) => total + length, 0) * 16000 / inputRate
  expect(Math.abs(sampleCount - expected)).toBeLessThanOrEqual(1)
})

