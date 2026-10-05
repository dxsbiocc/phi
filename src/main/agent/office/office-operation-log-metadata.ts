import type { PersistedOfficeSaveStatus } from './office-save-state'

export type OfficeReconcileConclusion =
  'applied' | 'not_applied' | 'indeterminate' | 'applied_no_change'

export interface OfficeReconcileSummary {
  readonly conclusion: OfficeReconcileConclusion
  readonly at: string
  readonly reason?: string
  readonly revision: number
  readonly saved?: boolean
}

export interface OfficeOperationLogMetadata extends PersistedOfficeSaveStatus {
  readonly lastReconcile?: OfficeReconcileSummary
}

export const OFFICE_OPERATION_METADATA_FIELDS = [
  'lastReconcile',
  'saveState',
  'lastSavedRevision',
  'lastSavedAt',
  'savedDraftHash'
] as const

export function persistedOfficeOperationMetadata(
  metadata: OfficeOperationLogMetadata
): Record<string, unknown> {
  return {
    ...(metadata.lastReconcile ? { lastReconcile: metadata.lastReconcile } : {}),
    ...(metadata.saveState ? { saveState: metadata.saveState } : {}),
    ...(metadata.lastSavedRevision === undefined
      ? {}
      : { lastSavedRevision: metadata.lastSavedRevision }),
    ...(metadata.lastSavedAt ? { lastSavedAt: metadata.lastSavedAt } : {}),
    ...(metadata.savedDraftHash ? { savedDraftHash: metadata.savedDraftHash } : {})
  }
}

export function decodeOfficeOperationMetadata(
  body: Record<string, unknown>,
  contentRevision: number
): OfficeOperationLogMetadata {
  const lastReconcile =
    body.lastReconcile === undefined ? undefined : decodedReconcileSummary(body.lastReconcile)
  const saveState = decodedSaveState(body.saveState)
  const lastSavedRevision = decodedSavedRevision(body.lastSavedRevision, contentRevision)
  const lastSavedAt = decodedTimestamp(body.lastSavedAt, 'save timestamp')
  const savedDraftHash = decodedHash(body.savedDraftHash)
  if (saveState === 'saved' && lastSavedRevision !== undefined) {
    if (lastSavedRevision !== contentRevision) throw new Error('invalid saved revision')
  }
  return {
    ...(lastReconcile ? { lastReconcile } : {}),
    ...(saveState ? { saveState } : {}),
    ...(lastSavedRevision === undefined ? {} : { lastSavedRevision }),
    ...(lastSavedAt ? { lastSavedAt } : {}),
    ...(savedDraftHash ? { savedDraftHash } : {})
  }
}

function decodedReconcileSummary(value: unknown): OfficeReconcileSummary {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['conclusion', 'at', 'reason', 'revision', 'saved'])
  ) {
    throw new Error('invalid reconcile summary')
  }
  const conclusions = ['applied', 'not_applied', 'indeterminate', 'applied_no_change']
  if (
    !conclusions.includes(String(value.conclusion)) ||
    !decodedTimestamp(value.at, 'reconcile timestamp') ||
    !validRevision(value.revision) ||
    (value.reason !== undefined && typeof value.reason !== 'string') ||
    (value.saved !== undefined && typeof value.saved !== 'boolean')
  ) {
    throw new Error('invalid reconcile summary')
  }
  return {
    conclusion: value.conclusion as OfficeReconcileConclusion,
    at: value.at as string,
    revision: value.revision,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.saved === 'boolean' ? { saved: value.saved } : {})
  }
}

function decodedSaveState(value: unknown): PersistedOfficeSaveStatus['saveState'] {
  if (value === undefined) return undefined
  if (!['saved', 'unsaved', 'failed'].includes(String(value))) {
    throw new Error('invalid operation log save state')
  }
  return value as NonNullable<PersistedOfficeSaveStatus['saveState']>
}

function decodedSavedRevision(value: unknown, contentRevision: number): number | undefined {
  if (value === undefined) return undefined
  if (!validRevision(value) || value > contentRevision) throw new Error('invalid saved revision')
  return value
}

function decodedTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`invalid ${label}`)
  }
  return value
}

function decodedHash(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error('invalid saved draft hash')
  }
  return value
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}
