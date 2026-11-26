export type EntityId = string
export type ISODateTime = string

export interface AuditMetadata {
  createdAt: ISODateTime
  createdBy: EntityId
  updatedAt: ISODateTime
  updatedBy: EntityId
  /** Optimistic-lock revision. Incremented on every persisted mutation. */
  revision: number
}

export interface VersionMetadata {
  /** Human-facing version number, starting at 1. */
  version: number
  versionId: EntityId
  isCurrentVersion: boolean
  effectiveAt?: ISODateTime
  supersededAt?: ISODateTime
}

export interface BaseDTO extends AuditMetadata {
  id: EntityId
}

export interface VersionedDTO extends BaseDTO, VersionMetadata {}

export interface PaginationQuery {
  page?: number
  pageSize?: number
}

export interface PaginationMeta {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface Money {
  amount: number
  currency: string
}

export interface FileReference {
  fileName: string
  mimeType: string
  sizeBytes: number
  storageKey: string
  sha256: string
}

export interface ActorReference {
  id: EntityId
  displayName: string
  role?: string
}

export interface TimelineEvent extends BaseDTO {
  entityType: string
  entityId: EntityId
  eventType: string
  summary: string
  actor?: ActorReference
  metadata?: Record<string, unknown>
}

