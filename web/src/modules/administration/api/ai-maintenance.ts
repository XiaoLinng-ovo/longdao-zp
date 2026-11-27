import { apiClient } from '../../../shared/api'

export interface AiMigrationPreview {
  sourceOrganizationId: string; sourceName: string; sourceDigest: string; targetDigest: string;
  model: string; baseUrlHost: string; originalBaseUrl?: string; baseUrl?: string; updatedAt: string | null; platformExists: boolean;
  affectedOrganizationCount: number; decryptable: boolean; errorCode: string | null; canMigrate: boolean
}
export interface AiDiagnosis {
  platform: { configured: boolean; model: string; updatedAt: string | null };
  source: 'platform' | 'enterprise' | 'legacy_enterprise' | null;
  effective: boolean; decryptable: boolean; errorCode: string | null; candidates: AiMigrationPreview[]
}
export interface AiGenerationProbe { ok: boolean; code: string | null; model: string; latencyMs: number }
export async function diagnoseAi(): Promise<AiDiagnosis> {
  return (await apiClient.getJson<AiDiagnosis>('/admin/ai-diagnostics')).data
}
export async function probeAiGeneration(): Promise<AiGenerationProbe> {
  return (await apiClient.postJson<AiGenerationProbe>('/admin/ai-generation-test',{})).data
}
export async function importLegacyAi(preview: AiMigrationPreview) {
  return (await apiClient.postJson('/admin/ai-legacy-import',{
    sourceOrganizationId: preview.sourceOrganizationId, sourceDigest: preview.sourceDigest, targetDigest: preview.targetDigest,
    ...(preview.baseUrl === undefined ? {} : {baseUrl:preview.baseUrl}),
  })).data
}
export async function previewLegacyAi(sourceOrganizationId: string, baseUrl: string): Promise<AiMigrationPreview> {
  return (await apiClient.postJson<AiMigrationPreview>('/admin/ai-legacy-preview',{sourceOrganizationId,baseUrl})).data
}
