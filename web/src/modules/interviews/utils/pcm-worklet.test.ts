import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

it('flushes every sample before a boundary and records nothing while paused', () => {
  const messages: Array<{ type: string; samples?: Float32Array; id?: number }> = []
  const registered = vi.fn()
  runInNewContext(readFileSync(new URL('../../../../public/interview-pcm-worklet.js', import.meta.url), 'utf8'), {
    Float32Array,
    AudioWorkletProcessor: class { port = { postMessage: (data: typeof messages[number]) => messages.push(data) } },
    registerProcessor: registered,
  })
  const Processor = registered.mock.calls[0]![1]
  const processor = new Processor()
  const samples = Float32Array.from({ length: 4200 }, (_, index) => index / 4200)
  processor.process([[samples]])
  expect(messages).toEqual([])
  processor.port.onmessage({ data: { type: 'resume' } })
  processor.process([[samples]])
  processor.port.onmessage({ data: { type: 'pause', id: 7 } })
  expect(messages.map(row => row.type)).toEqual(['pcm', 'pcm', 'boundary'])
  expect(messages.map(row => row.samples?.length ?? row.id)).toEqual([4096, 104, 7])
  expect([...messages[0]!.samples!, ...messages[1]!.samples!]).toEqual([...samples])
  processor.process([[samples]])
  expect(messages).toHaveLength(3)
  processor.port.onmessage({ data: { type: 'resume' } })
  processor.process([[Float32Array.of(.5, .75)]])
  processor.port.onmessage({ data: { type: 'pause', id: 8 } })
  expect([...messages[3]!.samples!]).toEqual([.5, .75])
  expect(messages[4]).toEqual({ type: 'boundary', id: 8 })
})
