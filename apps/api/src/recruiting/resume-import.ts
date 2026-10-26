import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'

export type ResumeImportBatchStatus = 'uploading' | 'completed' | 'cancelled'
export type ResumeImportItemStatus = 'pending_upload' | 'uploading' | 'queued' | 'failed' | 'cancelled'

export interface ResumeImportItem {
  id: string
  batchId: string
  ordinal: number
  clientFileId: string
  originalFilename: string
  mimeType: string
  sizeBytes: number
  status: ResumeImportItemStatus
  candidateId?: string
  applicationId?: string
  resumeId?: string
  analysisTaskId?: string
  analysisStatus?: string
  attempts: number
  error?: string
  createdAt: string
  updatedAt: string
}

export interface ResumeImportBatch {
  id: string
  jobId: string
  status: ResumeImportBatchStatus
  items: ResumeImportItem[]
  counts: {
    total: number
    pendingUpload: number
    uploading: number
    uploaded: number
    analyzing: number
    completed: number
    failed: number
    cancelled: number
  }
  createdAt: string
  updatedAt: string
  cancelledAt?: string
}

export interface ResumeImportFileInput {
  clientFileId: string
  originalFilename: string
  mimeType: string
  sizeBytes: number
}

export interface ResumeImportItemPatch {
  status?: ResumeImportItemStatus
  candidateId?: string
  applicationId?: string
  resumeId?: string
  analysisTaskId?: string
  error?: string | null
  incrementAttempts?: boolean
}

export interface ResumeImportStore {
  createBatch(input: { jobId: string; createdBy: string; files: ResumeImportFileInput[] }): Promise<ResumeImportBatch>
  getBatch(batchId: string): Promise<ResumeImportBatch | undefined>
  listBatches(limit: number): Promise<ResumeImportBatch[]>
  updateItem(batchId: string, itemId: string, patch: ResumeImportItemPatch): Promise<ResumeImportItem>
  cancelBatch(batchId: string): Promise<ResumeImportBatch>
  completeBatchIfDone(batchId: string): Promise<void>
}

export interface ResumeImportRecruiting {
  createCandidate(input: { fullName: string; source?: string }, actorId?: string): Promise<{ id: string }>
  createApplication(input: { candidateId: string; jobId: string; source?: string }, actorId?: string): Promise<{ id: string }>
  createResume(input: {
    candidateId: string
    applicationId?: string
    originalFilename: string
    mimeType?: string
    content: string
    encoding?: 'utf8' | 'base64'
  }, actorId?: string): Promise<{
    resume: { id: string }
    task: { id: string }
  }>
}

export class ResumeImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'ResumeImportError'
  }
}

const MAX_FILES_PER_BATCH = 500
const MAX_FILE_BYTES = 10 * 1024 * 1024
const STALE_UPLOAD_MS = 2 * 60 * 1000
const SUPPORTED_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'txt', 'md'])
const MIME_BY_EXTENSION: Record<string, Set<string>> = {
  pdf: new Set(['application/pdf']),
  doc: new Set(['application/msword']),
  docx: new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  txt: new Set(['text/plain']),
  md: new Set(['text/markdown', 'text/plain']),
}

function now(): string {
  return new Date().toISOString()
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function validateFile(input: ResumeImportFileInput): ResumeImportFileInput {
  const clientFileId = clean(input.clientFileId)
  const originalFilename = clean(input.originalFilename)
  const mimeType = clean(input.mimeType).toLowerCase()
  const parts = originalFilename.toLowerCase().split('.')
  const extension = parts.length === 2 ? parts[1]! : ''
  if (!clientFileId) throw new ResumeImportError('VALIDATION_ERROR', 'clientFileId 不能为空')
  if (!originalFilename || /[\\/]/.test(originalFilename) || originalFilename.includes('..')) {
    throw new ResumeImportError('INVALID_RESUME_FILENAME', `简历文件名无效：${originalFilename || '(empty)'}`)
  }
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new ResumeImportError('UNSUPPORTED_RESUME_EXTENSION', `不支持此文件格式：${originalFilename}`)
  if (!MIME_BY_EXTENSION[extension]!.has(mimeType)) throw new ResumeImportError('RESUME_MIME_MISMATCH', `文件类型与扩展名不匹配：${originalFilename}`)
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) throw new ResumeImportError('INVALID_FILE_SIZE', `文件为空：${originalFilename}`)
  if (input.sizeBytes > MAX_FILE_BYTES) throw new ResumeImportError('FILE_TOO_LARGE', `单份简历不能超过 10 MB：${originalFilename}`)
  return { clientFileId, originalFilename, mimeType, sizeBytes: input.sizeBytes }
}

function batchCounts(items: ResumeImportItem[]): ResumeImportBatch['counts'] {
  const statusOf = (item: ResumeImportItem): string => item.status === 'queued' && item.analysisStatus ? item.analysisStatus : item.status
  return {
    total: items.length,
    pendingUpload: items.filter((item) => item.status === 'pending_upload').length,
    uploading: items.filter((item) => item.status === 'uploading').length,
    uploaded: items.filter((item) => item.status === 'queued' || statusOf(item) === 'completed').length,
    analyzing: items.filter((item) => statusOf(item) === 'processing').length,
    completed: items.filter((item) => statusOf(item) === 'completed').length,
    failed: items.filter((item) => item.status === 'failed' || statusOf(item) === 'failed').length,
    cancelled: items.filter((item) => item.status === 'cancelled').length,
  }
}

function withCounts(batch: Omit<ResumeImportBatch, 'counts'>): ResumeImportBatch {
  return { ...batch, counts: batchCounts(batch.items) }
}

export class MemoryResumeImportStore implements ResumeImportStore {
  private readonly batches = new Map<string, ResumeImportBatch>()

  async createBatch(input: { jobId: string; createdBy: string; files: ResumeImportFileInput[] }): Promise<ResumeImportBatch> {
    const timestamp = now()
    const batchId = randomUUID()
    const files = input.files.map(validateFile)
    const batch = withCounts({
      id: batchId,
      jobId: input.jobId,
      status: 'uploading',
      items: files.map((file, index) => ({
        id: randomUUID(),
        batchId,
        ordinal: index + 1,
        ...file,
        status: 'pending_upload',
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    this.batches.set(batchId, clone(batch))
    return clone(batch)
  }

  async getBatch(batchId: string): Promise<ResumeImportBatch | undefined> {
    const batch = this.batches.get(batchId)
    return batch ? clone(batch) : undefined
  }

  async listBatches(limit: number): Promise<ResumeImportBatch[]> {
    return [...this.batches.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(clone)
  }

  async updateItem(batchId: string, itemId: string, patch: ResumeImportItemPatch): Promise<ResumeImportItem> {
    const batch = this.batches.get(batchId)
    if (!batch) throw new ResumeImportError('BATCH_NOT_FOUND', '导入批次不存在', 404)
    const item = batch.items.find((candidate) => candidate.id === itemId)
    if (!item) throw new ResumeImportError('ITEM_NOT_FOUND', '批次文件不存在', 404)
    if (patch.status !== undefined) item.status = patch.status
    if (patch.candidateId !== undefined) item.candidateId = patch.candidateId
    if (patch.applicationId !== undefined) item.applicationId = patch.applicationId
    if (patch.resumeId !== undefined) item.resumeId = patch.resumeId
    if (patch.analysisTaskId !== undefined) item.analysisTaskId = patch.analysisTaskId
    if (patch.error !== undefined) {
      if (patch.error === null) delete item.error
      else item.error = patch.error
    }
    if (patch.incrementAttempts) item.attempts += 1
    item.updatedAt = now()
    batch.updatedAt = item.updatedAt
    this.batches.set(batchId, clone(batch))
    return clone(item)
  }

  async cancelBatch(batchId: string): Promise<ResumeImportBatch> {
    const batch = this.batches.get(batchId)
    if (!batch) throw new ResumeImportError('BATCH_NOT_FOUND', '导入批次不存在', 404)
    if (batch.status !== 'cancelled') {
      batch.status = 'cancelled'
      batch.cancelledAt = now()
      batch.updatedAt = batch.cancelledAt
      for (const item of batch.items) {
        if (item.status === 'pending_upload' || item.status === 'failed') {
          item.status = 'cancelled'
          item.updatedAt = batch.cancelledAt
        }
      }
    }
    batch.counts = batchCounts(batch.items)
    this.batches.set(batchId, clone(batch))
    return clone(batch)
  }

  async completeBatchIfDone(batchId: string): Promise<void> {
    const batch = this.batches.get(batchId)
    if (!batch || batch.status !== 'uploading') return
    if (batch.items.some((item) => item.status === 'pending_upload' || item.status === 'uploading')) return
    batch.status = 'completed'
    batch.updatedAt = now()
    batch.counts = batchCounts(batch.items)
    this.batches.set(batchId, clone(batch))
  }
}

interface BatchRow extends QueryResultRow {
  id: string
  job_id: string
  status: ResumeImportBatchStatus
  created_at: Date | string
  updated_at: Date | string
  cancelled_at: Date | string | null
}

interface ItemRow extends QueryResultRow {
  id: string
  batch_id: string
  ordinal: number
  client_file_id: string
  original_filename: string
  mime_type: string
  size_bytes: string | number
  status: ResumeImportItemStatus
  candidate_id: string | null
  application_id: string | null
  resume_id: string | null
  analysis_task_id: string | null
  analysis_status: string | null
  attempts: number
  error: string | null
  created_at: Date | string
  updated_at: Date | string
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function mapItem(row: ItemRow): ResumeImportItem {
  return {
    id: row.id,
    batchId: row.batch_id,
    ordinal: row.ordinal,
    clientFileId: row.client_file_id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    ...(row.candidate_id ? { candidateId: row.candidate_id } : {}),
    ...(row.application_id ? { applicationId: row.application_id } : {}),
    ...(row.resume_id ? { resumeId: row.resume_id } : {}),
    ...(row.analysis_task_id ? { analysisTaskId: row.analysis_task_id } : {}),
    ...(row.analysis_status ? { analysisStatus: row.analysis_status } : {}),
    attempts: row.attempts,
    ...(row.error ? { error: row.error } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

const BATCH_SELECT = `SELECT b.id, b.job_id, b.status, b.created_at, b.updated_at, b.cancelled_at
  FROM resume_import_batches b`
const ITEM_SELECT = `SELECT i.id, i.batch_id, i.ordinal, i.client_file_id, i.original_filename, i.mime_type,
  i.size_bytes, i.status, i.candidate_id, i.application_id, i.resume_id, i.analysis_task_id,
  t.status AS analysis_status, i.attempts, i.error, i.created_at, i.updated_at
  FROM resume_import_items i
  LEFT JOIN analysis_tasks t ON t.id = i.analysis_task_id AND t.organization_id = i.organization_id`

export class PostgresResumeImportStore implements ResumeImportStore {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  private async mapBatch(row: BatchRow, items: ResumeImportItem[]): Promise<ResumeImportBatch> {
    return withCounts({
      id: row.id,
      jobId: row.job_id,
      status: row.status,
      items,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      ...(row.cancelled_at ? { cancelledAt: iso(row.cancelled_at) } : {}),
    })
  }

  async createBatch(input: { jobId: string; createdBy: string; files: ResumeImportFileInput[] }): Promise<ResumeImportBatch> {
    const files = input.files.map(validateFile)
    const batchId = randomUUID()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const batch = await client.query<BatchRow>(
        `INSERT INTO resume_import_batches (id, organization_id, job_id, created_by, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'uploading')
         RETURNING id, job_id, status, created_at, updated_at, cancelled_at`,
        [batchId, this.organizationId, input.jobId, input.createdBy],
      )
      const row = batch.rows[0]
      if (!row) throw new ResumeImportError('BATCH_CREATE_FAILED', '无法创建导入批次', 500)
      for (const [index, file] of files.entries()) {
        await client.query(
          `INSERT INTO resume_import_items
             (id, batch_id, organization_id, ordinal, client_file_id, original_filename, mime_type, size_bytes, status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, 'pending_upload')`,
          [randomUUID(), batchId, this.organizationId, index + 1, file.clientFileId, file.originalFilename, file.mimeType, file.sizeBytes],
        )
      }
      await client.query('COMMIT')
      const created = await this.getBatch(batchId)
      if (!created) throw new ResumeImportError('BATCH_CREATE_FAILED', '导入批次创建后不可读取', 500)
      return created
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async getBatch(batchId: string): Promise<ResumeImportBatch | undefined> {
    const batch = await this.pool.query<BatchRow>(
      `${BATCH_SELECT} WHERE b.id = $1::uuid AND b.organization_id = $2::uuid`,
      [batchId, this.organizationId],
    )
    const row = batch.rows[0]
    if (!row) return undefined
    const items = await this.pool.query<ItemRow>(
      `${ITEM_SELECT} WHERE i.batch_id = $1::uuid AND i.organization_id = $2::uuid ORDER BY i.ordinal`,
      [batchId, this.organizationId],
    )
    return this.mapBatch(row, items.rows.map(mapItem))
  }

  async listBatches(limit: number): Promise<ResumeImportBatch[]> {
    const batches = await this.pool.query<BatchRow>(
      `${BATCH_SELECT} WHERE b.organization_id = $1::uuid ORDER BY b.created_at DESC LIMIT $2`,
      [this.organizationId, limit],
    )
    return Promise.all(batches.rows.map(async (row) => {
      const items = await this.pool.query<ItemRow>(
        `${ITEM_SELECT} WHERE i.batch_id = $1::uuid AND i.organization_id = $2::uuid ORDER BY i.ordinal`,
        [row.id, this.organizationId],
      )
      return this.mapBatch(row, items.rows.map(mapItem))
    }))
  }

  async updateItem(batchId: string, itemId: string, patch: ResumeImportItemPatch): Promise<ResumeImportItem> {
    const assignments: string[] = []
    const values: unknown[] = [batchId, itemId, this.organizationId]
    const add = (sql: string, value?: unknown) => {
      if (value !== undefined) values.push(value)
      assignments.push(sql.replace('?', `$${values.length}`))
    }
    if (patch.status !== undefined) add('status = ?', patch.status)
    if (patch.candidateId !== undefined) add('candidate_id = ?::uuid', patch.candidateId)
    if (patch.applicationId !== undefined) add('application_id = ?::uuid', patch.applicationId)
    if (patch.resumeId !== undefined) add('resume_id = ?::uuid', patch.resumeId)
    if (patch.analysisTaskId !== undefined) add('analysis_task_id = ?::uuid', patch.analysisTaskId)
    if (patch.error !== undefined) add('error = ?', patch.error)
    if (patch.incrementAttempts) assignments.push('attempts = attempts + 1')
    assignments.push('updated_at = now()')
    const updated = await this.pool.query<ItemRow>(
      `UPDATE resume_import_items i SET ${assignments.join(', ')}
       WHERE i.batch_id = $1::uuid AND i.id = $2::uuid AND i.organization_id = $3::uuid
       RETURNING i.id, i.batch_id, i.ordinal, i.client_file_id, i.original_filename, i.mime_type,
         i.size_bytes, i.status, i.candidate_id, i.application_id, i.resume_id, i.analysis_task_id,
         NULL::text AS analysis_status, i.attempts, i.error, i.created_at, i.updated_at`,
      values,
    )
    const row = updated.rows[0]
    if (!row) throw new ResumeImportError('ITEM_NOT_FOUND', '批次文件不存在', 404)
    return mapItem(row)
  }

  async cancelBatch(batchId: string): Promise<ResumeImportBatch> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query<{ id: string }>(
        `SELECT id FROM resume_import_batches
         WHERE id = $1::uuid AND organization_id = $2::uuid FOR UPDATE`,
        [batchId, this.organizationId],
      )
      if (!locked.rows[0]) throw new ResumeImportError('BATCH_NOT_FOUND', '导入批次不存在', 404)
      await client.query(
        `UPDATE resume_import_batches
         SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()), updated_at = now()
         WHERE id = $1::uuid AND organization_id = $2::uuid`,
        [batchId, this.organizationId],
      )
      await client.query(
        `UPDATE resume_import_items
         SET status = 'cancelled', updated_at = now()
         WHERE batch_id = $1::uuid AND organization_id = $2::uuid
           AND status IN ('pending_upload', 'failed')`,
        [batchId, this.organizationId],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    const batch = await this.getBatch(batchId)
    if (!batch) throw new ResumeImportError('BATCH_NOT_FOUND', '导入批次不存在', 404)
    return batch
  }

  async completeBatchIfDone(batchId: string): Promise<void> {
    await this.pool.query(
      `UPDATE resume_import_batches b SET status = 'completed', updated_at = now()
       WHERE b.id = $1::uuid AND b.organization_id = $2::uuid AND b.status = 'uploading'
         AND NOT EXISTS (
           SELECT 1 FROM resume_import_items i
           WHERE i.batch_id = b.id AND i.organization_id = b.organization_id
             AND i.status IN ('pending_upload', 'uploading')
         )`,
      [batchId, this.organizationId],
    )
  }
}

export class ResumeImportService {
  constructor(
    private readonly store: ResumeImportStore,
    private readonly recruiting: ResumeImportRecruiting,
  ) {}

  async createBatch(input: { jobId?: unknown; files?: unknown }, actorId: string): Promise<ResumeImportBatch> {
    const jobId = clean(input.jobId)
    if (!jobId) throw new ResumeImportError('VALIDATION_ERROR', '请选择简历对应岗位')
    if (!Array.isArray(input.files) || input.files.length === 0) throw new ResumeImportError('VALIDATION_ERROR', '请选择简历文件')
    if (input.files.length > MAX_FILES_PER_BATCH) throw new ResumeImportError('BATCH_TOO_LARGE', `单个批次最多 ${MAX_FILES_PER_BATCH} 份简历`)
    const files = input.files.map((value) => {
      if (!value || typeof value !== 'object') throw new ResumeImportError('VALIDATION_ERROR', '文件元数据无效')
      const record = value as Record<string, unknown>
      return validateFile({
        clientFileId: clean(record.clientFileId),
        originalFilename: clean(record.originalFilename),
        mimeType: clean(record.mimeType),
        sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : -1,
      })
    })
    const unique = new Set(files.map((file) => file.clientFileId))
    if (unique.size !== files.length) throw new ResumeImportError('DUPLICATE_CLIENT_FILE_ID', '同一批次包含重复文件标识')
    return this.store.createBatch({ jobId, createdBy: actorId, files })
  }

  async getBatch(batchId: string): Promise<ResumeImportBatch> {
    const batch = await this.store.getBatch(batchId)
    if (!batch) throw new ResumeImportError('BATCH_NOT_FOUND', '导入批次不存在', 404)
    return batch
  }

  async listBatches(limit = 20): Promise<ResumeImportBatch[]> {
    return this.store.listBatches(Math.max(1, Math.min(Math.floor(limit), 100)))
  }

  async cancelBatch(batchId: string): Promise<ResumeImportBatch> {
    return this.store.cancelBatch(batchId)
  }

  async uploadItem(
    batchId: string,
    itemId: string,
    input: { content?: unknown; encoding?: unknown },
    actorId = 'user-demo',
  ): Promise<ResumeImportItem> {
    const batch = await this.getBatch(batchId)
    const item = batch.items.find((candidate) => candidate.id === itemId)
    if (!item) throw new ResumeImportError('ITEM_NOT_FOUND', '批次文件不存在', 404)
    if (batch.status === 'cancelled' && !item.candidateId) {
      throw new ResumeImportError('BATCH_CANCELLED', '批次已取消，该文件未上传', 409)
    }
    if (item.status === 'queued' && item.analysisTaskId) return item
    if (item.status === 'uploading' && Date.now() - Date.parse(item.updatedAt) < STALE_UPLOAD_MS) {
      throw new ResumeImportError('UPLOAD_IN_PROGRESS', '该文件正在上传，请稍后重试', 409)
    }
    if (item.status === 'cancelled') throw new ResumeImportError('ITEM_CANCELLED', '该文件已取消上传', 409)
    if (typeof input.content !== 'string' || !input.content) throw new ResumeImportError('VALIDATION_ERROR', '简历内容不能为空')

    await this.store.updateItem(batchId, itemId, { status: 'uploading', incrementAttempts: true, error: null })
    try {
      let candidateId = item.candidateId
      if (!candidateId) {
        const candidate = await this.recruiting.createCandidate({
          fullName: '待解析候选人',
          source: `resume-import:${item.ordinal}`,
        }, actorId)
        candidateId = candidate.id
        await this.store.updateItem(batchId, itemId, { candidateId })
      }

      let applicationId = item.applicationId
      if (!applicationId) {
        const application = await this.recruiting.createApplication({
          candidateId,
          jobId: batch.jobId,
          source: '简历导入',
        }, actorId)
        applicationId = application.id
        await this.store.updateItem(batchId, itemId, { applicationId })
      }

      const uploaded = await this.recruiting.createResume({
        candidateId,
        applicationId,
        originalFilename: item.originalFilename,
        mimeType: item.mimeType,
        content: input.content,
        encoding: input.encoding === 'utf8' ? 'utf8' : 'base64',
      }, actorId)
      const queued = await this.store.updateItem(batchId, itemId, {
        status: 'queued',
        resumeId: uploaded.resume.id,
        analysisTaskId: uploaded.task.id,
        error: null,
      })
      await this.store.completeBatchIfDone(batchId)
      return queued
    } catch (error) {
      await this.store.updateItem(batchId, itemId, {
        status: 'failed',
        error: error instanceof Error ? error.message : '上传失败',
      }).catch(() => undefined)
      await this.store.completeBatchIfDone(batchId).catch(() => undefined)
      throw error
    }
  }
}
