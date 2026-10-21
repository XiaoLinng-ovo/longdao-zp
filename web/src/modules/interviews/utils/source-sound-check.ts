import type { InterviewAudioLevels, InterviewAudioSource } from './audio-capture'

/** Track each source independently. A live track alone is not proof of sound. */
export function createSourceSoundCheck(sources: InterviewAudioSource[]) {
  const detected = { microphone: false, meeting: false }
  const consecutive = { microphone: 0, meeting: 0 }
  let checkedSince: number | undefined
  return {
    update(levels: InterviewAudioLevels, now: number, paused = false) {
      if (paused) { checkedSince = undefined; consecutive.microphone = 0; consecutive.meeting = 0 }
      else {
        checkedSince ??= now
        for (const source of sources) {
          consecutive[source] = levels[source] > 0.015 ? consecutive[source] + 1 : 0
          if (consecutive[source] >= 3) detected[source] = true
        }
      }
      return { detected: { ...detected }, missing: !paused && checkedSince !== undefined && now - checkedSince >= 20_000 ? sources.filter(source => !detected[source]) : [] }
    },
  }
}
