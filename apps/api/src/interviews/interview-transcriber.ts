import type { SpeakerSegment } from './role-mapper.js'
import { createFunAsrClient, loadFunAsrConfig } from './funasr-client.js'
import { runtimeFetch } from '@smartrecruit-pro/runtime-lifecycle'

/** Use FunASR for chunk recognition as well as the live stream; never switch engines. */
export async function transcribeInterviewChunk(
  audio: Uint8Array,
  contentType: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = runtimeFetch,
): Promise<SpeakerSegment[]> {
  return createFunAsrClient(loadFunAsrConfig(env), fetchImpl).transcribe(audio, contentType)
}

export async function transcribeLiveInterviewChunk(
  audio: Uint8Array,
  contentType: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = runtimeFetch,
): Promise<SpeakerSegment[]> {
  const config = loadFunAsrConfig(env)
  // Live uploads need a shorter budget than background full-audio transcription.
  return createFunAsrClient({ ...config, timeoutMs: Math.min(config.timeoutMs, 45_000) }, fetchImpl).transcribe(audio, contentType)
}
