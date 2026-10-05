import { createHash, randomUUID } from 'node:crypto'
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  OfficeCellEditParams,
  OfficeWriteBefore,
  OfficeWriteRequest,
  OfficeWriteReceiptResult,
  OfficeWriteResult,
  OfficeWriteErrorCode
} from './office-write-contract'
import {
  OfficeWriteError,
  validateCellEditParams,
  validateRangeEditParams
} from './office-write-contract'
import {
  cellWriteRequest,
  formatRangeWriteRequest,
  officeWriteStrategy,
  rangeWriteRequest,
  validateStoredOfficeWriteRequest
} from './office-write-operation'
import { officeWriteDigest } from './office-write-digest'
import { decodeOfficeOperationReceipt } from './office-operation-receipt-codec'
import {
  decodeOfficeOperationMetadata,
  OFFICE_OPERATION_METADATA_FIELDS,
  persistedOfficeOperationMetadata,
  type OfficeOperationLogMetadata,
  type OfficeReconcileConclusion,
  type OfficeReconcileSummary
} from './office-operation-log-metadata'

export type { OfficeReconcileConclusion, OfficeReconcileSummary }

export const OFFICE_OPERATION_LOG_VERSION = 2
export const MAX_TERMINAL_OFFICE_OPERATIONS = 500
export const OFFICE_OPERATION_LOG_FILENAME = 'operations.json'
export type OfficeOperationReceipt =
  | { readonly ok: true; readonly value: OfficeWriteResult }
  | {
      readonly ok: false
      readonly error: {
        readonly code: OfficeWriteErrorCode
        readonly result?: OfficeWriteReceiptResult
        readonly currentRevision?: number
        readonly sheetNames?: readonly string[]
      }
    }
export interface OfficeOperationRecord {
  readonly digest: string
  readonly status: 'in_flight' | 'succeeded' | 'failed'
  readonly receipt?: OfficeOperationReceipt
  readonly createdAt: string
  readonly operation?: OfficeWriteRequest | OfficeCellEditParams
  readonly before?: OfficeWriteBefore
  readonly source?: 'human'
}

export interface OfficeOperationLogState extends OfficeOperationLogMetadata {
  readonly version: 1 | 2
  readonly contentRevision: number
  readonly operations: Readonly<Record<string, OfficeOperationRecord>>
  readonly freezeState?: 'unknown'
  readonly needsSave?: boolean
  readonly lastReconcile?: OfficeReconcileSummary
  readonly integrityError?: 'operation_log_corrupt'
}

interface OfficeOperationLogDependencies {
  readonly randomId?: () => string
  readonly rename?: typeof rename
  readonly writeFile?: typeof writeFile
  readonly rm?: typeof rm
}

interface OfficeOperationLogLoadDependencies {
  readonly clock?: () => number
  readonly copyFile?: typeof copyFile
  readonly readFile?: typeof readFile
}

function emptyOperationLog(): OfficeOperationLogState {
  return { version: OFFICE_OPERATION_LOG_VERSION, contentRevision: 0, operations: {} }
}

export async function loadOfficeOperationLog(
  draftPath: string,
  dependencies: OfficeOperationLogLoadDependencies = {}
): Promise<OfficeOperationLogState> {
  const path = join(dirname(draftPath), OFFICE_OPERATION_LOG_FILENAME)
  try {
    const bytes = await (dependencies.readFile ?? readFile)(path, 'utf8')
    return decodedOperationLog(JSON.parse(bytes as string))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyOperationLog()
    try {
      await backupCorruptLog(path, dependencies)
    } catch {
      throw new OfficeWriteError('operation_log_corrupt', '写入记录无法验证，文档已冻结等待核对')
    }
    return {
      ...emptyOperationLog(),
      freezeState: 'unknown',
      integrityError: 'operation_log_corrupt'
    }
  }
}

export async function persistOfficeOperationLog(
  draftPath: string,
  state: OfficeOperationLogState,
  dependencies: OfficeOperationLogDependencies = {}
): Promise<void> {
  if (state.integrityError) throw new Error('operation log is corrupt')
  const directory = dirname(draftPath)
  const path = join(directory, OFFICE_OPERATION_LOG_FILENAME)
  const tempPath = join(
    directory,
    `${OFFICE_OPERATION_LOG_FILENAME}.tmp-${(dependencies.randomId ?? randomUUID)()}`
  )
  const body = persistedBody(state)
  const bytes = `${JSON.stringify({ ...body, checksum: checksum(body) }, null, 2)}\n`
  let tempCreated = false
  try {
    await (dependencies.writeFile ?? writeFile)(tempPath, bytes, { flag: 'wx' })
    tempCreated = true
    await (dependencies.rename ?? rename)(tempPath, path)
  } catch (error) {
    if (tempCreated) {
      await (dependencies.rm ?? rm)(tempPath, { force: true }).catch(() => undefined)
    }
    throw error
  }
}
function persistedBody(state: OfficeOperationLogState): Record<string, unknown> {
  const operations = Object.fromEntries(
    Object.entries(state.operations).sort(([left], [right]) => left.localeCompare(right))
  )
  return {
    version: OFFICE_OPERATION_LOG_VERSION,
    contentRevision: state.contentRevision,
    operations,
    ...(state.freezeState ? { freezeState: state.freezeState } : {}),
    ...(state.needsSave ? { needsSave: true } : {}),
    ...persistedOfficeOperationMetadata(state)
  }
}

function checksum(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function decodedOperationLog(value: unknown): OfficeOperationLogState {
  if (!isRecord(value)) throw new Error('invalid operation log')
  const { checksum: storedChecksum, ...body } = value
  if (typeof storedChecksum !== 'string' || storedChecksum !== checksum(body)) {
    throw new Error('invalid operation log checksum')
  }
  if (body.version !== 1 && body.version !== OFFICE_OPERATION_LOG_VERSION) {
    throw new Error('unsupported operation log')
  }
  const allowedFields =
    body.version === 1
      ? ['version', 'contentRevision', 'operations', 'freezeState', 'needsSave']
      : [
          'version',
          'contentRevision',
          'operations',
          'freezeState',
          'needsSave',
          ...OFFICE_OPERATION_METADATA_FIELDS
        ]
  if (!hasOnlyKeys(body, allowedFields)) {
    throw new Error('invalid operation log fields')
  }
  if (!validRevision(body.contentRevision) || !isRecord(body.operations)) {
    throw new Error('invalid operation log')
  }
  if (body.freezeState !== undefined && body.freezeState !== 'unknown') {
    throw new Error('invalid operation log freeze state')
  }
  if (body.needsSave !== undefined && body.needsSave !== true) {
    throw new Error('invalid operation log save state')
  }
  const operations = decodedOperations(body.operations, body.version)
  const metadata =
    body.version === 1 ? {} : decodeOfficeOperationMetadata(body, body.contentRevision)
  const recoveredInFlight = Object.values(operations).some((entry) => entry.status === 'in_flight')
  return {
    version: OFFICE_OPERATION_LOG_VERSION,
    contentRevision: body.contentRevision,
    operations,
    ...(body.freezeState === 'unknown' || recoveredInFlight ? { freezeState: 'unknown' } : {}),
    ...(body.needsSave === true ? { needsSave: true } : {}),
    ...metadata
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

async function backupCorruptLog(
  path: string,
  dependencies: OfficeOperationLogLoadDependencies
): Promise<void> {
  const backupPath = `${path}.corrupt-${(dependencies.clock ?? Date.now)()}`
  try {
    await (dependencies.copyFile ?? copyFile)(path, backupPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

function decodedOperations(
  value: Record<string, unknown>,
  version: 1 | 2
): Record<string, OfficeOperationRecord> {
  const entries = Object.entries(value).map(([operationId, record]) => {
    if (!operationId || operationId.length > 200 || !isRecord(record)) {
      throw new Error('invalid operation record')
    }
    const allowedFields =
      version === 1
        ? ['digest', 'status', 'receipt', 'createdAt']
        : ['digest', 'status', 'receipt', 'createdAt', 'operation', 'before', 'source']
    if (!hasOnlyKeys(record, allowedFields)) {
      throw new Error('invalid operation record fields')
    }
    if (!/^[a-f0-9]{64}$/u.test(String(record.digest))) {
      throw new Error('invalid operation digest')
    }
    if (!['in_flight', 'succeeded', 'failed'].includes(String(record.status))) {
      throw new Error('invalid operation status')
    }
    if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
      throw new Error('invalid operation timestamp')
    }
    const status = record.status as OfficeOperationRecord['status']
    const receipt =
      record.receipt === undefined ? undefined : decodeOfficeOperationReceipt(record.receipt)
    if ((status === 'in_flight') !== (receipt === undefined)) {
      throw new Error('invalid operation receipt state')
    }
    if (status === 'succeeded' && receipt?.ok !== true) throw new Error('invalid success receipt')
    if (status === 'failed' && receipt?.ok !== false) throw new Error('invalid failure receipt')
    const hasOperation = Object.hasOwn(record, 'operation')
    const hasBefore = Object.hasOwn(record, 'before')
    if (hasOperation !== hasBefore) throw new Error('incomplete operation prewrite evidence')
    const operation = hasOperation ? decodedOperation(record.operation, version) : undefined
    if (record.source !== undefined && record.source !== 'human') {
      throw new Error('invalid operation source')
    }
    if (operation && officeOperationDigest(operation) !== record.digest) {
      throw new Error('operation prewrite digest mismatch')
    }
    if (operation && hasBefore) {
      const request = storedOperationRequest(operation)
      officeWriteStrategy(request.operation).restoreBefore(
        request.operation,
        record.before as OfficeWriteBefore
      )
    }
    return [
      operationId,
      {
        digest: record.digest,
        status,
        createdAt: record.createdAt,
        ...(receipt ? { receipt } : {}),
        ...(operation ? { operation, before: record.before as OfficeWriteBefore } : {}),
        ...(record.source === 'human' ? { source: 'human' as const } : {})
      }
    ]
  })
  return Object.fromEntries(entries) as Record<string, OfficeOperationRecord>
}

function decodedOperation(
  value: unknown,
  version: 1 | 2
): OfficeWriteRequest | OfficeCellEditParams {
  if (version === 2 && isRecord(value) && Object.hasOwn(value, 'operation')) {
    if (isRecord(value.operation) && value.operation.type === 'format_range') {
      return formatRangeWriteRequest({
        sheet: value.operation.sheet,
        range: value.operation.range,
        format: value.operation.format,
        baseRevision: value.baseRevision
      })
    }
    if (isRecord(value.operation) && value.operation.type === 'set_range') {
      return rangeWriteRequest(
        validateRangeEditParams({
          sheet: value.operation.sheet,
          range: value.operation.range,
          values: value.operation.values,
          baseRevision: value.baseRevision
        })
      )
    }
    return validateStoredOfficeWriteRequest(value)
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ['sheet', 'cell', 'value', 'baseRevision'])) {
    throw new Error('invalid operation prewrite')
  }
  return validateCellEditParams(value)
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function officeOperationDigest(input: OfficeWriteRequest | OfficeCellEditParams): string {
  const request = storedOperationRequest(input)
  return officeWriteDigest(request)
}
export function storedOperationRequest(
  input: OfficeWriteRequest | OfficeCellEditParams
): OfficeWriteRequest {
  return 'operation' in input ? input : cellWriteRequest(input)
}

export function pruneOfficeOperationLog(state: OfficeOperationLogState): OfficeOperationLogState {
  const entries = Object.entries(state.operations)
  const terminal = entries.filter(([, entry]) => entry.status !== 'in_flight')
  if (terminal.length <= MAX_TERMINAL_OFFICE_OPERATIONS) return state
  const newestFirst = terminal.toSorted(
    ([leftId, left], [rightId, right]) =>
      right.createdAt.localeCompare(left.createdAt) || rightId.localeCompare(leftId)
  )
  const latestSuccess = newestFirst.find(([, entry]) => entry.status === 'succeeded')
  const kept = new Set(latestSuccess ? [latestSuccess[0]] : [])
  for (const [operationId] of newestFirst) {
    if (kept.size >= MAX_TERMINAL_OFFICE_OPERATIONS) break
    kept.add(operationId)
  }
  const operations = Object.fromEntries(
    entries.filter(([operationId, entry]) => entry.status === 'in_flight' || kept.has(operationId))
  )
  return { ...state, operations }
}

export function startOfficeOperation(
  state: OfficeOperationLogState,
  operationId: string,
  digest: string,
  createdAt: string,
  source?: 'human'
): OfficeOperationLogState {
  return {
    ...state,
    operations: {
      ...state.operations,
      [operationId]: { digest, status: 'in_flight', createdAt, ...(source ? { source } : {}) }
    }
  }
}
export function recordOfficeOperationPrewrite(
  state: OfficeOperationLogState,
  operationId: string,
  operation: OfficeWriteRequest | OfficeCellEditParams,
  before: OfficeWriteBefore
): OfficeOperationLogState {
  const request = storedOperationRequest(operation)
  const pending = state.operations[operationId]
  if (!pending || pending.status !== 'in_flight') throw new Error('operation is not in flight')
  if (pending.digest !== officeOperationDigest(request))
    throw new Error('operation digest mismatch')
  return {
    ...state,
    version: OFFICE_OPERATION_LOG_VERSION,
    operations: {
      ...state.operations,
      [operationId]: {
        ...pending,
        operation:
          request.operation.type === 'set_cell'
            ? {
                sheet: request.operation.sheet,
                cell: request.operation.cell,
                value: request.operation.value,
                baseRevision: request.baseRevision
              }
            : request,
        before
      }
    }
  }
}

export function completeOfficeOperation(
  state: OfficeOperationLogState,
  operationId: string,
  receipt: OfficeOperationReceipt,
  contentRevision: number,
  flags: { readonly freeze?: boolean; readonly needsSave?: boolean } = {}
): OfficeOperationLogState {
  const pending = state.operations[operationId]
  if (!pending) throw new Error('operation is not in flight')
  const keepEvidence =
    !receipt.ok &&
    (receipt.error.code === 'write_unknown' || receipt.error.code === 'write_verification_failed')
  return pruneOfficeOperationLog({
    ...state,
    contentRevision,
    operations: {
      ...state.operations,
      [operationId]: {
        digest: pending.digest,
        status: receipt.ok ? 'succeeded' : 'failed',
        receipt,
        createdAt: pending.createdAt,
        ...(pending.source ? { source: pending.source } : {}),
        ...(keepEvidence && pending.operation
          ? { operation: pending.operation, before: pending.before }
          : {})
      }
    },
    ...(state.freezeState === 'unknown' || flags.freeze ? { freezeState: 'unknown' } : {}),
    ...(state.needsSave || flags.needsSave ? { needsSave: true } : {})
  })
}
