import { OFFICE_WORKBOOK_LIMITS } from './office-limits'
import { officeSheetNameIssue } from './office-read-contract'
import { OfficeWriteError } from './office-write-contract'
import type { OfficeWriteSnapshot } from './office-write-contract'
import { normalizeOfficeWriteRevision } from './office-write-validation'

export const OFFICE_MAX_WORKBOOK_SHEETS = OFFICE_WORKBOOK_LIMITS.maxSheets

export interface OfficeAddSheetParams {
  readonly name: string
  readonly baseRevision: number
}

export function addSheetSnapshot(
  sheetNames: readonly string[],
  addedSheetEmpty?: boolean
): OfficeWriteSnapshot {
  return Object.freeze({
    cells: Object.freeze([]),
    rowCount: 0,
    columnCount: 0,
    sheetNames: Object.freeze([...sheetNames]),
    ...(addedSheetEmpty === undefined ? {} : { addedSheetEmpty })
  })
}

export function validateAddSheetParams(value: unknown): OfficeAddSheetParams {
  if (!isRecord(value) || !hasOnlyKeys(value, ['name', 'baseRevision'])) {
    throw new OfficeWriteError('invalid_value', 'add_sheet 操作字段无效')
  }
  if (typeof value.name !== 'string') {
    throw new OfficeWriteError('invalid_sheet', '工作表名称必须是字符串')
  }
  const issue = officeSheetNameIssue(value.name)
  if (issue) throw new OfficeWriteError('invalid_sheet', sheetNameMessage(issue))
  return Object.freeze({
    name: value.name,
    baseRevision: normalizeOfficeWriteRevision(value.baseRevision)
  })
}

function sheetNameMessage(issue: NonNullable<ReturnType<typeof officeSheetNameIssue>>): string {
  if (issue === 'empty') return '工作表名称不能为空或全是空白'
  if (issue === 'length') return '工作表名称长度必须为 1 到 31 个字符'
  if (issue === 'surrounding_whitespace') return '工作表名称不能包含前后空白'
  if (issue === 'surrounding_apostrophe') return '工作表名称不能以单引号开头或结尾'
  if (issue === 'forbidden_character') return '工作表名称不能包含 \\ / ? * [ ] :'
  return '工作表名称不能包含控制字符'
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
