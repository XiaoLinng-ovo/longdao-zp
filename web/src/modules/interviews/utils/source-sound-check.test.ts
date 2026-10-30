import { describe, expect, it } from 'vitest'
import { createSourceSoundCheck } from './source-sound-check'
describe('per-source sound checks', () => {
  it('does not let a working microphone conceal silent meeting audio', () => {
    const check = createSourceSoundCheck(['microphone','meeting'])
    expect(check.update({microphone:.2,meeting:0},0).detected.microphone).toBe(false)
    check.update({microphone:.2,meeting:0},150)
    expect(check.update({microphone:.2,meeting:0},300).detected).toEqual({microphone:true,meeting:false})
    expect(check.update({microphone:.2,meeting:0},21000).missing).toEqual(['meeting'])
    check.update({microphone:0,meeting:.1},21150); check.update({microphone:0,meeting:.1},21300)
    expect(check.update({microphone:0,meeting:.1},21450)).toEqual({detected:{microphone:true,meeting:true},missing:[]})
    expect(check.update({microphone:0,meeting:0},50000).missing).toEqual([])
  })
  it('ignores single spikes and paused time, and never requires a meeting track in microphone mode', () => {
    const check = createSourceSoundCheck(['microphone'])
    check.update({microphone:.2,meeting:0},0); check.update({microphone:0,meeting:0},150)
    expect(check.update({microphone:.2,meeting:0},300).detected.microphone).toBe(false)
    expect(check.update({microphone:0,meeting:0},90000,true).missing).toEqual([])
    expect(check.update({microphone:0,meeting:0},90150).missing).toEqual([])
    expect(check.update({microphone:0,meeting:0},111000).missing).toEqual(['microphone'])
  })
})
