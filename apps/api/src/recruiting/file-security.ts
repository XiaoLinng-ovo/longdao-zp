import { createHash, randomUUID } from 'node:crypto'

export type ResumeScanStatus = 'quarantined' | 'clean' | 'rejected' | 'infected'

export interface ResumeUploadInput {
  filename: string
  mimeType: string
  content: Uint8Array
  maxBytes?: number
}

export interface QuarantineFile {
  originalFilename: string
  safeFilename: string
  extension: 'pdf' | 'docx' | 'doc' | 'txt' | 'md'
  mimeType: string
  sizeBytes: number
  contentHash: string
  objectKey: string
  scanStatus: ResumeScanStatus
  withScanResult(status: Exclude<ResumeScanStatus, 'quarantined'>): QuarantineFile
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const MIME_BY_EXTENSION: Record<QuarantineFile['extension'], Set<string>> = {
  pdf: new Set(['application/pdf']),
  docx: new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  doc: new Set(['application/msword']),
  txt: new Set(['text/plain']),
  md: new Set(['text/markdown', 'text/plain']),
} as const

function fail(message: string): never {
  throw new Error(message)
}

function safeName(filename: string): string {
  const trimmed = filename.trim()
  if (!trimmed || trimmed.includes('..') || /[\\/]/.test(trimmed) || /[\u0000-\u001f]/.test(trimmed)) fail('Invalid resume filename')
  const normalized = trimmed.normalize('NFKC').replace(/[^\p{L}\p{N}\s._-]/gu, '_').replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.startsWith('.') || normalized.endsWith('.')) fail('Invalid resume filename')
  return normalized
}

function extensionOf(filename: string): QuarantineFile['extension'] {
  const parts = filename.toLowerCase().split('.')
  if (parts.length !== 2) fail('Resume filename must contain exactly one extension')
  const extension = parts[1]
  if (extension !== 'pdf' && extension !== 'docx' && extension !== 'doc' && extension !== 'txt' && extension !== 'md') fail('Unsupported resume extension')
  return extension
}

export function sha256Hex(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

export function validateResumeUpload(input: ResumeUploadInput): QuarantineFile {
  const safeFilename = safeName(input.filename)
  const extension = extensionOf(safeFilename)
  const mimeType = input.mimeType.trim().toLowerCase()
  if (!MIME_BY_EXTENSION[extension].has(mimeType)) fail('Resume MIME type does not match extension')
  const sizeBytes = input.content.byteLength
  if (sizeBytes <= 0) fail('Resume content cannot be empty')
  if (sizeBytes > (input.maxBytes ?? DEFAULT_MAX_BYTES)) fail('Resume file is too large')
  const objectKey = `resumes/quarantine/${randomUUID()}.${extension}`
  const file: Omit<QuarantineFile, 'withScanResult'> = {
    originalFilename: input.filename,
    safeFilename,
    extension,
    mimeType,
    sizeBytes,
    contentHash: sha256Hex(input.content),
    objectKey,
    scanStatus: 'quarantined',
  }
  return attachTransition(file)
}

function attachTransition(file: Omit<QuarantineFile, 'withScanResult'>): QuarantineFile {
  return {
    ...file,
    withScanResult(status) {
      if ((status as ResumeScanStatus) === 'quarantined') fail('Invalid scan status transition: quarantined is an initial status only')
      if (file.scanStatus !== 'quarantined') fail(`Invalid scan status transition: ${file.scanStatus} -> ${status}`)
      return attachTransition({ ...file, scanStatus: status })
    },
  }
}

export function createQuarantineFile(input: ResumeUploadInput): QuarantineFile {
  return validateResumeUpload(input)
}
