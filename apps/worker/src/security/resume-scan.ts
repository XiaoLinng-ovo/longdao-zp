import { resolve } from 'node:path'
import type { MalwareScanResult } from './clamd-client.js'
import type { ResumeScanStatus } from '../db/analysis-task-store.js'
import { createLocalObjectStorage, type ObjectStorage } from '@smartrecruit-pro/object-storage'

export interface ResumeScanClaim { resumeId: string; storageKey: string }
export interface ResumeScanStore {
  claimNextResumeForScan(): Promise<ResumeScanClaim | undefined>
  updateResumeScanStatus(resumeId: string, status: Exclude<ResumeScanStatus, 'quarantined' | 'scanning'>): Promise<ResumeScanStatus>
}
export interface ResumeScanner { scan(content: Buffer): Promise<MalwareScanResult> }

export async function processNextResumeScan(options: {
  store: ResumeScanStore
  scanner: ResumeScanner
  quarantineRoot?: string
  storage?: ObjectStorage
}): Promise<(MalwareScanResult & { resumeId: string }) | undefined> {
  const claim = await options.store.claimNextResumeForScan()
  if (!claim) return undefined
  try {
    const content = options.storage
      ? await options.storage.get(claim.storageKey)
      : await createLocalObjectStorage(options.quarantineRoot ?? resolve(process.cwd(), '../../data/resumes/quarantine')).get(claim.storageKey)
    const result = await options.scanner.scan(content)
    await options.store.updateResumeScanStatus(claim.resumeId, result.status)
    return { resumeId: claim.resumeId, ...result }
  } catch (error: unknown) {
    await options.store.updateResumeScanStatus(claim.resumeId, 'failed')
    throw error
  }
}

export function startResumeScanPoll(options: {
  store: ResumeScanStore
  scanner: ResumeScanner
  quarantineRoot?: string
  storage?: ObjectStorage
  pollIntervalMs: number
  logger?: Pick<Console, 'error' | 'warn' | 'log'>
}): () => void {
  const logger = options.logger ?? console
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const outcome = await processNextResumeScan(options)
      if (outcome?.status === 'infected') logger.warn(`[resume-scan] resume ${outcome.resumeId} infected: ${outcome.signature}`)
      else if (outcome) logger.log(`[resume-scan] resume ${outcome.resumeId} clean`)
    } catch (error: unknown) {
      logger.error(`[resume-scan] failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally { running = false }
  }
  void tick()
  const interval = setInterval(() => void tick(), options.pollIntervalMs)
  interval.unref?.()
  return () => clearInterval(interval)
}
