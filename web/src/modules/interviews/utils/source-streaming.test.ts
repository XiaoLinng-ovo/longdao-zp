// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createSourceStreaming } from './source-streaming'

const channels: ReturnType<typeof createSourceStreaming>[] = []
afterEach(() => { channels.forEach(channel => channel.dispose()); channels.length = 0; vi.unstubAllGlobals() })

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

