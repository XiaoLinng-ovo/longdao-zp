import type { ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ObjectRead } from '@smartrecruit-pro/object-storage'

function prepareAudioResponse(res: ServerResponse, byteLength: number, contentType: string, range?: string): { start: number; end: number } | undefined {
  res.setHeader('Content-Type', /^(audio\/[a-z0-9.+-]+)(;[^\r\n]*)?$/i.test(contentType) ? contentType : 'application/octet-stream')
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Accept-Ranges', 'bytes')
  let start = 0, end = byteLength - 1
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, byteLength - Number(match[2]))
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end
    }
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start >= byteLength || end < start || (!match[1] && Number(match[2]) === 0)) {
      res.statusCode = 416
      res.setHeader('Content-Range', 'bytes */' + byteLength)
      res.end()
      return
    }
    res.statusCode = 206
    res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + byteLength)
  } else res.statusCode = 200
  res.setHeader('Content-Length', Math.max(0, end - start + 1))
  return { start, end }
}

export function sendInterviewAudio(res: ServerResponse, audio: Buffer, contentType: string, range?: string) {
  const selected = prepareAudioResponse(res, audio.length, contentType, range)
  if (selected) res.end(audio.subarray(selected.start, selected.end + 1))
}

export async function sendInterviewAudioStream(res: ServerResponse, audio: ObjectRead, contentType: string, range?: string, signal?: AbortSignal): Promise<void> {
  const abort = () => audio.body.destroy()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(audio.byteLength) || audio.byteLength < 0 || audio.byteLength > 128 * 1024 * 1024) throw new Error('音频输出长度超过上限')
    const selected = prepareAudioResponse(res, audio.byteLength, contentType, range)
    if (!selected) return
    const body = Readable.from((async function* () {
      let received = 0
      for await (const chunk of audio.body) {
        const before = received
        received += chunk.length
        if (received > audio.byteLength) throw new Error('音频实际长度超过声明值')
        if (received > selected.start) yield chunk.subarray(Math.max(0, selected.start - before), Math.min(chunk.length, selected.end + 1 - before))
        if (range && received > selected.end) return
      }
      if (received !== audio.byteLength) throw new Error('音频文件读取不完整')
    })(), { objectMode: false })
    await pipeline(body, res, { signal })
  } finally { signal?.removeEventListener('abort', abort); audio.body.destroy() }
}
