import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import type { OfficeDocumentKind } from '../../../shared/officeProtocol'
import { OFFICE_EXPORT_LIMITS } from './office-export-contract'
import { validOfficeSheetName } from './office-read-contract'

export const OFFICE_OUTPUT_LOG_FILENAME = 'outputs.json'
export const MAX_OFFICE_OUTPUT_RECORDS = 100

export interface OfficeDeliveryCheck {
  readonly name: 'schema' | 'xlsx_content' | 'docx_content' | 'pptx_content'
  readonly status: 'passed'
  readonly sampled?: number
  readonly pageCount?: number
}

export interface OfficeOutputRecord {
  readonly outputId: string
  readonly outputPath: string
  readonly revision: number
  readonly sha256: string
  readonly size: number
  readonly createdAt: string
  readonly source: 'draft'
}

export interface OfficeDeliveryOutputRecord extends OfficeOutputRecord {
  readonly operationId: string
  readonly requestDigest: string
  readonly kind: OfficeDocumentKind
  readonly checks: readonly OfficeDeliveryCheck[]
  readonly warnings: readonly string[]
}

export interface OfficeExportOutputRecord extends OfficeOutputRecord {
  readonly requestId: string
  readonly requestDigest: string
  readonly format: 'csv' | 'tsv'
  readonly sheet: string
  readonly rows: number
  readonly columns: number
}

export interface OfficeOutputLogState {
  readonly version: 1 | 2 | 3
  readonly outputs: readonly OfficeOutputRecord[]
}

export class OfficeOutputLogError extends Error {
  readonly code = 'output_log_corrupt' as const

  constructor() {
    super('Office 输出记录无法验证')
    this.name = 'OfficeOutputLogError'
  }
}

interface OutputLogDependencies {
  readonly randomId?: () => string
  readonly writeFile?: typeof writeFile
  readonly rename?: typeof rename
  readonly rm?: typeof rm
}

export async function loadOfficeOutputLog(draftPath: string): Promise<OfficeOutputLogState> {
  try {
    const value = JSON.parse(
      await readFile(join(dirname(draftPath), OFFICE_OUTPUT_LOG_FILENAME), 'utf8')
    )
    return decodeOutputLog(value)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, outputs: [] }
    if (error instanceof OfficeOutputLogError) throw error
    throw new OfficeOutputLogError()
  }
}

export async function persistOfficeOutputLog(
  draftPath: string,
  state: OfficeOutputLogState,
  dependencies: OutputLogDependencies = {}
): Promise<void> {
  const directory = dirname(draftPath)
  const path = join(directory, OFFICE_OUTPUT_LOG_FILENAME)
  const tempPath = join(
    directory,
    `${OFFICE_OUTPUT_LOG_FILENAME}.tmp-${(dependencies.randomId ?? randomUUID)()}`
  )
  const body = { version: state.version, outputs: state.outputs }
  const checksum = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  let created = false
  try {
    await (dependencies.writeFile ?? writeFile)(
      tempPath,
      `${JSON.stringify({ ...body, checksum }, null, 2)}\n`,
      { flag: 'wx' }
    )
    created = true
    await (dependencies.rename ?? rename)(tempPath, path)
  } catch (error) {
    if (created) await (dependencies.rm ?? rm)(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export function appendOfficeOutputRecord(
  state: OfficeOutputLogState,
  record: OfficeOutputRecord | OfficeDeliveryOutputRecord | OfficeExportOutputRecord
): OfficeOutputLogState {
  const version = isExportRecord(record)
    ? 3
    : isDeliveryRecord(record)
      ? Math.max(2, state.version)
      : state.version
  assertOutputRecord(record, version as OfficeOutputLogState['version'])
  if (state.outputs.some((entry) => entry.outputId === record.outputId)) {
    throw new OfficeOutputLogError()
  }
  if (
    isDeliveryRecord(record) &&
    state.outputs.some(
      (entry) => isDeliveryRecord(entry) && entry.operationId === record.operationId
    )
  ) {
    throw new OfficeOutputLogError()
  }
  if (
    isExportRecord(record) &&
    state.outputs.some((entry) => isExportRecord(entry) && entry.requestId === record.requestId)
  ) {
    throw new OfficeOutputLogError()
  }
  return {
    version: version as OfficeOutputLogState['version'],
    outputs: retainDeliveryRecords([...state.outputs, freezeOutputRecord(record)])
  }
}

function decodeOutputLog(value: unknown): OfficeOutputLogState {
  if (!isRecord(value)) throw new OfficeOutputLogError()
  const { checksum, ...body } = value
  const expected = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  if (
    checksum !== expected ||
    (body.version !== 1 && body.version !== 2 && body.version !== 3) ||
    !Array.isArray(body.outputs) ||
    Object.keys(body).some((key) => key !== 'version' && key !== 'outputs')
  ) {
    throw new OfficeOutputLogError()
  }
  const outputs = body.outputs.map((record) => {
    assertOutputRecord(record, body.version as OfficeOutputLogState['version'])
    return freezeOutputRecord(record as OfficeOutputRecord)
  })
  if (new Set(outputs.map((record) => record.outputId)).size !== outputs.length) {
    throw new OfficeOutputLogError()
  }
  const operationIds = outputs.flatMap((record) =>
    isDeliveryRecord(record) ? [record.operationId] : []
  )
  if (new Set(operationIds).size !== operationIds.length) throw new OfficeOutputLogError()
  const requestIds = outputs.flatMap((record) => (isExportRecord(record) ? [record.requestId] : []))
  if (new Set(requestIds).size !== requestIds.length) throw new OfficeOutputLogError()
  if (
    outputs.filter((record) => !isDeliveryRecord(record) && !isExportRecord(record)).length >
    MAX_OFFICE_OUTPUT_RECORDS
  ) {
    throw new OfficeOutputLogError()
  }
  return { version: body.version as OfficeOutputLogState['version'], outputs }
}

function retainDeliveryRecords(
  records: readonly OfficeOutputRecord[]
): readonly OfficeOutputRecord[] {
  let legacyRemaining = MAX_OFFICE_OUTPUT_RECORDS
  return records
    .toReversed()
    .filter((record) => isDeliveryRecord(record) || isExportRecord(record) || legacyRemaining-- > 0)
    .toReversed()
}

function assertOutputRecord(
  value: unknown,
  version: OfficeOutputLogState['version']
): asserts value is OfficeOutputRecord {
  if (!isRecord(value)) throw new OfficeOutputLogError()
  const delivery = hasDeliveryFields(value)
  const exported = hasExportFields(value)
  const expectedFields = delivery ? 12 : exported ? 13 : 7
  if (
    (delivery && exported) ||
    Object.keys(value).length !== expectedFields ||
    (delivery && version < 2) ||
    (exported && version !== 3)
  ) {
    throw new OfficeOutputLogError()
  }
  if (
    typeof value.outputId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(value.outputId) ||
    typeof value.outputPath !== 'string' ||
    !validRelativeOutputPath(value.outputPath) ||
    !validInteger(value.revision, 0) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !validInteger(value.size, exported ? 0 : 1) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    value.source !== 'draft'
  ) {
    throw new OfficeOutputLogError()
  }
  if (delivery) assertDeliveryFields(value)
  if (exported) assertExportFields(value)
}

function assertExportFields(value: Record<string, unknown>): void {
  if (
    typeof value.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(value.requestId) ||
    typeof value.requestDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.requestDigest) ||
    (value.format !== 'csv' && value.format !== 'tsv') ||
    typeof value.sheet !== 'string' ||
    !validOfficeSheetName(value.sheet) ||
    !validInteger(value.rows, 0) ||
    !validInteger(value.columns, 0) ||
    value.rows > OFFICE_EXPORT_LIMITS.maxRows ||
    value.columns > OFFICE_EXPORT_LIMITS.maxColumns ||
    value.rows * value.columns > OFFICE_EXPORT_LIMITS.maxCells ||
    (value.rows === 0) !== (value.columns === 0) ||
    !String(value.outputPath).toLowerCase().endsWith(`.${value.format}`)
  ) {
    throw new OfficeOutputLogError()
  }
}

function assertDeliveryFields(value: Record<string, unknown>): void {
  if (
    typeof value.operationId !== 'string' ||
    value.operationId.length === 0 ||
    value.operationId.length > 200 ||
    /\p{Cc}/u.test(value.operationId) ||
    typeof value.requestDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.requestDigest) ||
    !['xlsx', 'docx', 'pptx'].includes(String(value.kind)) ||
    !Array.isArray(value.checks) ||
    value.checks.length < 2 ||
    value.checks.length > 8 ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 20 ||
    value.warnings.some(
      (warning) => typeof warning !== 'string' || warning.length > 200 || /\p{Cc}/u.test(warning)
    )
  ) {
    throw new OfficeOutputLogError()
  }
  value.checks.forEach(assertDeliveryCheck)
  const names = value.checks.map((check) => (check as OfficeDeliveryCheck).name)
  const contentName = `${String(value.kind)}_content` as OfficeDeliveryCheck['name']
  if (!names.includes('schema') || !names.includes(contentName)) {
    throw new OfficeOutputLogError()
  }
}

function assertDeliveryCheck(value: unknown): void {
  if (!isRecord(value) || value.status !== 'passed') throw new OfficeOutputLogError()
  const allowed = new Set(['name', 'status', 'sampled', 'pageCount'])
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new OfficeOutputLogError()
  if (!['schema', 'xlsx_content', 'docx_content', 'pptx_content'].includes(String(value.name))) {
    throw new OfficeOutputLogError()
  }
  if (value.sampled !== undefined && !validInteger(value.sampled, 0)) {
    throw new OfficeOutputLogError()
  }
  if (value.pageCount !== undefined && !validInteger(value.pageCount, 0)) {
    throw new OfficeOutputLogError()
  }
}

function hasDeliveryFields(value: Record<string, unknown>): boolean {
  return ['operationId', 'requestDigest', 'kind', 'checks', 'warnings'].every((key) =>
    Object.hasOwn(value, key)
  )
}

function hasExportFields(value: Record<string, unknown>): boolean {
  return ['requestId', 'requestDigest', 'format', 'sheet', 'rows', 'columns'].every((key) =>
    Object.hasOwn(value, key)
  )
}

export function isDeliveryRecord(record: OfficeOutputRecord): record is OfficeDeliveryOutputRecord {
  return Object.hasOwn(record, 'operationId')
}

export function isExportRecord(record: OfficeOutputRecord): record is OfficeExportOutputRecord {
  return Object.hasOwn(record, 'requestId')
}

function freezeOutputRecord(record: OfficeOutputRecord): OfficeOutputRecord {
  if (!isDeliveryRecord(record)) return Object.freeze({ ...record })
  return Object.freeze({
    ...record,
    checks: Object.freeze(record.checks.map((check) => Object.freeze({ ...check }))),
    warnings: Object.freeze([...record.warnings])
  })
}

function validRelativeOutputPath(path: string): boolean {
  return (
    path.length <= 4096 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !/\p{Cc}/u.test(path) &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..') &&
    /\.(?:xlsx|docx|pptx|csv|tsv)$/iu.test(path)
  )
}

function validInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
