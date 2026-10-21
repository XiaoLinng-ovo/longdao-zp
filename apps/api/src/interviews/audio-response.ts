import type { ServerResponse } from 'node:http'

export function sendInterviewAudio(res: ServerResponse, audio: Buffer, contentType: string, range?: string) {
  res.setHeader('Content-Type', /^(audio\/[a-z0-9.+-]+)(;[^\r\n]*)?$/i.test(contentType) ? contentType : 'application/octet-stream')
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Accept-Ranges', 'bytes')
  let start = 0, end = audio.length - 1
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, audio.length - Number(match[2]))
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end
    }
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start >= audio.length || end < start || (!match[1] && Number(match[2]) === 0)) {
      res.statusCode = 416
      res.setHeader('Content-Range', 'bytes */' + audio.length)
      res.end()
      return
    }
    res.statusCode = 206
    res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + audio.length)
  } else res.statusCode = 200
  const body = audio.subarray(start, end + 1)
  res.setHeader('Content-Length', body.length)
  res.end(body)
}
