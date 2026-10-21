import type { SpeakerSegment } from './role-mapper.js'
import { createFunAsrClient, loadFunAsrConfig } from './funasr-client.js'

/** Use FunASR for chunk recognition as well as the live stream; never switch engines. */
export async function transcribeInterviewChunk(
  audio: Uint8Array,
  contentType: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<SpeakerSegment[]> {
  return createFunAsrClient(loadFunAsrConfig(env), fetchImpl).transcribe(audio, contentType)
}
