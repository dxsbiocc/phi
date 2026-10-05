import type { OfficeCliRunResult } from './office-driver'
import { validOfficeSheetName } from './office-read-contract'
import { OfficeWriteError } from './office-write-contract'

export interface ParsedOfficeSheetSnapshot {
  readonly sheetNames: readonly string[]
  readonly emptySheetNames: readonly string[]
}

export function parseOfficeSheetSnapshot(result: OfficeCliRunResult): ParsedOfficeSheetSnapshot {
  const value = parseEnvelope(result)
  const data = value.data
  if (!isRecord(data) || data.matches !== 1 || !Array.isArray(data.results)) throw invalidResult()
  const workbook = data.results[0]
  if (
    data.results.length !== 1 ||
    !isRecord(workbook) ||
    workbook.path !== '/' ||
    workbook.type !== 'workbook' ||
    !Array.isArray(workbook.children) ||
    workbook.childCount !== workbook.children.length
  ) {
    throw invalidResult()
  }
  const parsed = workbook.children.map(parseSheet)
  const names = parsed.map((entry) => entry.name)
  if (new Set(names.map((name) => name.toUpperCase())).size !== names.length) {
    throw invalidResult()
  }
  return Object.freeze({
    sheetNames: Object.freeze(names),
    emptySheetNames: Object.freeze(parsed.filter((entry) => entry.empty).map((entry) => entry.name))
  })
}

export function assertSuccessfulAddSheetBatch(
  result: OfficeCliRunResult,
  expectedItems: number
): void {
  const value = parseBatchEnvelope(result)
  const data = value.data
  const items = isRecord(data) && Array.isArray(data.results) ? data.results : []
  const summary = isRecord(data) && isRecord(data.summary) ? data.summary : undefined
  if (summary?.atomicRolledBack === true) {
    throw new OfficeWriteError('write_failed', 'Office 已回滚新建工作表操作，未修改文档')
  }
  const valid =
    result.exitCode === 0 &&
    value.success === true &&
    items.length === expectedItems &&
    items.every(successfulBatchItem) &&
    summary?.total === expectedItems &&
    summary.executed === expectedItems &&
    summary.succeeded === expectedItems &&
    summary.failed === 0 &&
    summary.skipped === 0 &&
    !hasWarnings(value.warnings) &&
    !hasWarnings(data && isRecord(data) ? data.warnings : undefined)
  if (!valid) throw new OfficeWriteError('write_unknown', '新建工作表结果无法确认')
}

function parseEnvelope(result: OfficeCliRunResult): Record<string, unknown> {
  if (result.spawnError || result.timedOut || result.truncated || result.exitCode !== 0) {
    throw invalidResult()
  }
  try {
    const value = JSON.parse(result.stdout) as unknown
    if (!isRecord(value) || value.success !== true || hasWarnings(value.warnings)) {
      throw invalidResult()
    }
    return value
  } catch (error) {
    if (error instanceof OfficeWriteError) throw error
    throw invalidResult()
  }
}

function parseBatchEnvelope(result: OfficeCliRunResult): Record<string, unknown> {
  if (result.spawnError || result.timedOut || result.truncated) {
    throw new OfficeWriteError('write_unknown', '新建工作表结果无法确认')
  }
  try {
    const value = JSON.parse(result.stdout) as unknown
    if (!isRecord(value)) throw new Error('invalid')
    return value
  } catch {
    throw new OfficeWriteError('write_unknown', '新建工作表结果无法确认')
  }
}

function successfulBatchItem(value: unknown): boolean {
  if (!isRecord(value) || value.success !== true || hasWarnings(value.warnings)) return false
  return typeof value.output !== 'string' || !value.output.includes('UNSUPPORTED props:')
}

function parseSheet(value: unknown): { name: string; empty: boolean } {
  if (
    !isRecord(value) ||
    typeof value.preview !== 'string' ||
    !validOfficeSheetName(value.preview)
  ) {
    throw invalidResult()
  }
  if (
    value.type !== 'sheet' ||
    value.path !== `/${value.preview}` ||
    !Number.isSafeInteger(value.childCount) ||
    Number(value.childCount) < 0 ||
    !Array.isArray(value.children) ||
    value.children.length !== value.childCount
  ) {
    throw invalidResult()
  }
  return { name: value.preview, empty: value.childCount === 0 }
}

function hasWarnings(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined
}

function invalidResult(): OfficeWriteError {
  return new OfficeWriteError('write_failed', 'Office 返回了无法识别的工作表列表')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
