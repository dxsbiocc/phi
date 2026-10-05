import type { OfficeCliRunResult } from './office-driver'
import { OfficeWriteError } from './office-write-contract'

interface BatchItem {
  readonly success?: unknown
  readonly output?: unknown
  readonly warnings?: unknown
}

interface BatchEnvelope {
  readonly success?: unknown
  readonly warnings?: unknown
  readonly data?: {
    readonly results?: unknown
    readonly summary?: { readonly atomicRolledBack?: unknown }
    readonly warnings?: unknown
  }
}

function parsedJson(result: OfficeCliRunResult): BatchEnvelope {
  if (result.timedOut || result.spawnError || result.truncated) {
    throw new OfficeWriteError('write_unknown', '写入结果无法确认，文档已冻结等待核对')
  }
  try {
    const value = JSON.parse(result.stdout) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    return value as BatchEnvelope
  } catch {
    throw new OfficeWriteError('write_unknown', '写入结果无法确认，文档已冻结等待核对')
  }
}

function hasWarnings(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null
}

export function assertSuccessfulCellBatch(result: OfficeCliRunResult): void {
  const value = parsedJson(result)
  const results = value.data?.results
  if (value.success === true && !Array.isArray(results)) {
    throw new OfficeWriteError('write_unknown', '写入回执不完整，文档已冻结等待核对')
  }
  const items = Array.isArray(results) ? (results as BatchItem[]) : []
  const discarded = items.some(
    (item) => typeof item.output === 'string' && item.output.includes('UNSUPPORTED props:')
  )
  const warnings =
    hasWarnings(value.warnings) ||
    hasWarnings(value.data?.warnings) ||
    items.some((item) => hasWarnings(item.warnings))
  const failed =
    result.exitCode !== 0 ||
    value.success !== true ||
    items.length !== 1 ||
    items[0]?.success !== true ||
    value.data?.summary?.atomicRolledBack === true ||
    warnings ||
    discarded
  if (failed) throw new OfficeWriteError('write_failed', 'Office 未能可靠写入该单元格')
}

export function assertSuccessfulAtomicBatch(
  result: OfficeCliRunResult,
  expectedItems: number
): void {
  assertAtomicBatch(result, expectedItems, false)
}

export function assertSuccessfulFormulaRestoreBatch(
  result: OfficeCliRunResult,
  expectedItems: number
): void {
  assertAtomicBatch(result, expectedItems, true)
}

function assertAtomicBatch(
  result: OfficeCliRunResult,
  expectedItems: number,
  allowFormulaReplacementWarning: boolean
): void {
  const value = parsedJson(result)
  const results = value.data?.results
  const items = Array.isArray(results) ? (results as BatchItem[]) : []
  if (value.data?.summary?.atomicRolledBack === true) {
    throw new OfficeWriteError('write_failed', 'Office 已回滚整批写入，未修改文档')
  }
  const discarded = items.some(
    (item) => typeof item.output === 'string' && item.output.includes('UNSUPPORTED props:')
  )
  const warnings =
    (hasWarnings(value.warnings) &&
      !(allowFormulaReplacementWarning && formulaReplacementWarnings(value.warnings))) ||
    hasWarnings(value.data?.warnings) ||
    items.some((item) => hasWarnings(item.warnings))
  const completeSuccess =
    result.exitCode === 0 &&
    value.success === true &&
    items.length === expectedItems &&
    items.every((item) => item.success === true) &&
    !warnings &&
    !discarded
  if (!completeSuccess) {
    throw new OfficeWriteError('write_unknown', '整批写入结果无法确认，文档已冻结等待核对')
  }
}

function formulaReplacementWarnings(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((warning) => {
      if (!warning || typeof warning !== 'object' || Array.isArray(warning)) return false
      const record = warning as { code?: unknown; message?: unknown }
      return (
        record.code === 'warning' &&
        typeof record.message === 'string' &&
        /^Warning: Cell [A-Z]+[1-9]\d* has formula "[\s\S]+"; replacing with literal value\. Use --prop formula=… to update the formula instead\.$/u.test(
          record.message
        )
      )
    })
  )
}

export function assertSuccessfulSave(result: OfficeCliRunResult): void {
  if (result.timedOut || result.spawnError || result.truncated || result.exitCode !== 0) {
    throw new OfficeWriteError('save_failed', '内容已写入，但 Office 草稿保存失败')
  }
  try {
    const value = JSON.parse(result.stdout) as {
      success?: unknown
      warnings?: unknown
      data?: unknown
    }
    const dataWarnings =
      value.data && typeof value.data === 'object'
        ? (value.data as { warnings?: unknown }).warnings
        : undefined
    if (value.success !== true || hasWarnings(value.warnings) || hasWarnings(dataWarnings)) {
      throw new Error('unsuccessful')
    }
  } catch {
    throw new OfficeWriteError('save_failed', '内容已写入，但 Office 草稿保存失败')
  }
}
