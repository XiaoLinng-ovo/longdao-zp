import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasSubstantiveAnswer, restorePendingAudio, savePendingAudio } from './pending-audio'

afterEach(() => vi.unstubAllGlobals())
describe('pending interview audio', () => {
  it.each(['我。', '嗯。', '哇。', '啊啊啊啊。', '', '   '])('does not score fragments as substantive answers: %s', text => {
    expect(hasSubstantiveAnswer(text)).toBe(false)
  })
  it('preserves real answers and does not impose a fixed transcript length', () => {
    expect(hasSubstantiveAnswer('我负责招聘平台的开发。')).toBe(true)
    expect(hasSubstantiveAnswer('我负责招聘平台的开发。'.repeat(1000))).toBe(true)
  })
  it('never restores recordings without an authenticated tenant scope', async () => {
    expect(await restorePendingAudio('', 'session')).toEqual([])
  })
  it('reports unsupported persistent storage rather than pretending audio is safe', async () => {
    vi.stubGlobal('indexedDB', undefined)
    await expect(savePendingAudio({ id: 'chunk', scope: 'tenant:user:interview', sessionId: 'session', offsetMs: 0, endMs: 1000, contentType: 'audio/webm', audio: new Blob(['audio']) })).rejects.toThrow('不支持本地录音缓存')
  })
})
