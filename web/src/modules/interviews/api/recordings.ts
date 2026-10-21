import { apiClient } from '../../../shared/api'
import { resolveApiUrl } from '../../../shared/api/client'
import { getWorkspaceContext, invalidateWorkspaceContext } from '../../../shared/api/workspace-context'

export interface InterviewAudioRecording {
  audioSource?: 'microphone' | 'meeting'
  sourceRole?: 'interviewer' | 'candidate' | 'unknown'
  sourceMultipleSpeakers?: boolean
  id: string; sessionId: string; sessionStartedAt: string; offsetMs: number
  endMs: number | null; byteLength: number | null; contentType: string; createdAt: string
}
export async function listInterviewRecordings(interviewId: string, signal?: AbortSignal) {
  return (await apiClient.getJson<InterviewAudioRecording[]>('/interviews/' + encodeURIComponent(interviewId) + '/recordings', { signal })).data
}
export async function loadInterviewRecording(interviewId: string, recordingId: string, signal?: AbortSignal): Promise<Blob> {
  return loadAudio('/interviews/' + encodeURIComponent(interviewId) + '/recordings/' + encodeURIComponent(recordingId), signal)
}
export type FullAudioSource = 'all' | 'microphone' | 'meeting' | 'legacy'
export interface FullAudioTranscriptionJob { status: 'processing' | 'completed' | 'failed'; progress: number; text: string; error?: string; updatedAt: string }
export async function loadFullInterviewRecording(interviewId: string, sessionId: string, source: FullAudioSource = 'all', signal?: AbortSignal): Promise<Blob> {
  return loadAudio('/interviews/' + encodeURIComponent(interviewId) + '/recordings/full?' + new URLSearchParams({ sessionId, source }), signal)
}
function transcriptionPath(interviewId: string, sessionId: string, source: FullAudioSource) {
  return '/interviews/' + encodeURIComponent(interviewId) + '/recordings/transcription?' + new URLSearchParams({ sessionId, source })
}
export async function getFullAudioTranscription(interviewId: string, sessionId: string, source: FullAudioSource, signal?: AbortSignal) {
  return (await apiClient.getJson<FullAudioTranscriptionJob | null>(transcriptionPath(interviewId, sessionId, source), signal ? { signal } : undefined)).data
}
export async function startFullAudioTranscription(interviewId: string, sessionId: string, source: FullAudioSource, signal?: AbortSignal) {
  return (await apiClient.postJson<FullAudioTranscriptionJob>(transcriptionPath(interviewId, sessionId, source), {}, signal ? { signal } : undefined)).data
}
async function loadAudio(path: string, signal?: AbortSignal): Promise<Blob> {
  const workspace = getWorkspaceContext()
  const headers: Record<string, string> = { Accept: 'audio/*' }
  if (workspace.workspaceId) headers['x-workspace-id'] = workspace.workspaceId
  const response = await fetch(resolveApiUrl(apiClient.baseUrl, path), {
    credentials: 'include', headers, signal,
  })
  if (getWorkspaceContext().revision !== workspace.revision) throw new Error('登录或工作空间已变更，请重新打开录音。')
  if (!response.ok) {
    if (response.status === 409) invalidateWorkspaceContext()
    const body = await response.json().catch(() => null)
    throw new Error(body?.error?.message || (response.status === 401 ? '登录已过期，请重新登录。' : '原音频加载失败，请重试。'))
  }
  const blob = await response.blob()
  if (getWorkspaceContext().revision !== workspace.revision) throw new Error('登录或工作空间已变更，请重新打开录音。')
  return blob
}
