import {
  sanitizeFormulaEditDescription,
  sanitizeFormulaEditResult,
  sanitizeFormulaInvalidResult
} from './office-formula-tool-sanitizer'
import {
  OfficeWriteError,
  type OfficeCellEditDescription,
  type OfficeCellEditResult,
  type OfficeCellValue,
  type OfficeAddSheetDescription,
  type OfficeAddSheetResult,
  type OfficeFormatRangeDescription,
  type OfficeFormatRangeResult,
  type OfficeRangeEditDescription,
  type OfficeRangeEditResult,
  type OfficeRangePreviewCell,
  type OfficeRangeFormat,
  type OfficeWriteDescription,
  type OfficeWriteReceiptResult,
  type OfficeWriteRequest
} from './office-write-contract'
import { sanitizeDocxWriteDescription, sanitizeDocxWriteResult } from './office-docx-tool-sanitizer'
import { sanitizePptxWriteDescription, sanitizePptxWriteResult } from './office-pptx-tool-sanitizer'

export const OFFICE_NO_TARGET_MESSAGE =
  '当前运行没有关联的 Office 文档，请先在右侧打开表格并在输入框里关联它'

export function sanitizeCellEditDescription(value: unknown): OfficeCellEditDescription {
  if (!isRecord(value)) throw invalidResult('写入说明无效')
  return Object.freeze({
    documentName: requiredString(value.documentName),
    sheet: requiredString(value.sheet),
    cell: requiredString(value.cell),
    before: requiredCellValue(value.before, true),
    after: requiredCellValue(value.after, false),
    revision: requiredRevision(value.revision)
  })
}

export function sanitizeWriteDescription(
  request: OfficeWriteRequest,
  value: unknown
): OfficeWriteDescription {
  if (request.operation.type === 'add_slide' || request.operation.type === 'set_slide_text') {
    return sanitizePptxWriteDescription(value)
  }
  if (
    request.operation.type === 'add_paragraph' ||
    request.operation.type === 'set_paragraph_text'
  ) {
    return sanitizeDocxWriteDescription(value)
  }
  return request.operation.type === 'add_sheet'
    ? sanitizeAddSheetDescription(value)
    : request.operation.type === 'set_formula'
      ? sanitizeFormulaEditDescription(value)
      : request.operation.type === 'format_range'
        ? sanitizeFormatRangeDescription(value)
        : sanitizeRangeEditDescription(value)
}

export function sanitizeAddSheetResult(value: unknown): OfficeAddSheetResult {
  if (!isRecord(value) || !Array.isArray(value.sheetNames)) {
    throw invalidResult('新建工作表结果无效')
  }
  const sheet = requiredString(value.sheet)
  const sheetNames = Object.freeze(value.sheetNames.map(requiredString))
  if (value.path !== `/${sheet}` || value.sheetCount !== sheetNames.length) {
    throw invalidResult('新建工作表结果无效')
  }
  const warnings = safeStringArray(value.warnings)
  return Object.freeze({
    applied: true,
    saved: value.saved === true,
    revision: requiredRevision(value.revision),
    sheet,
    path: value.path,
    sheetCount: sheetNames.length,
    sheetNames,
    previewConfirmed: value.previewConfirmed === true,
    ...(warnings ? { warnings } : {}),
    ...(value.deduplicated === true ? { deduplicated: true as const } : {}),
    ...(value.reconciled === true ? { reconciled: true as const } : {})
  })
}

export function sanitizeCellEditResult(value: unknown): OfficeCellEditResult {
  if (!isRecord(value)) throw invalidResult('写入结果无效')
  const warnings = safeStringArray(value.warnings)
  return Object.freeze({
    applied: value.applied === true,
    saved: value.saved === true,
    revision: requiredRevision(value.revision),
    sheet: requiredString(value.sheet),
    cell: requiredString(value.cell),
    before: requiredCellValue(value.before, true),
    after: requiredCellValue(value.after, false),
    previewConfirmed: value.previewConfirmed === true,
    ...(warnings ? { warnings } : {}),
    ...(value.deduplicated === true ? { deduplicated: true as const } : {}),
    ...(value.reconciled === true ? { reconciled: true as const } : {})
  })
}

export function sanitizeRangeEditResult(value: unknown): OfficeRangeEditResult {
  if (!isRecord(value)) throw invalidResult('范围写入结果无效')
  const warnings = safeStringArray(value.warnings)
  return Object.freeze({
    applied: value.applied === true,
    saved: value.saved === true,
    revision: requiredRevision(value.revision),
    sheet: requiredString(value.sheet),
    range: requiredString(value.range),
    rowCount: requiredPositiveInteger(value.rowCount),
    columnCount: requiredPositiveInteger(value.columnCount),
    changedCells: requiredNonnegativeInteger(value.changedCells),
    preview: safeRangePreview(value.preview),
    beforeHash: requiredHash(value.beforeHash),
    afterHash: requiredHash(value.afterHash),
    previewConfirmed: value.previewConfirmed === true,
    ...(warnings ? { warnings } : {}),
    ...(value.deduplicated === true ? { deduplicated: true as const } : {}),
    ...(value.reconciled === true ? { reconciled: true as const } : {})
  })
}

export function sanitizeFormatRangeResult(value: unknown): OfficeFormatRangeResult {
  if (!isRecord(value) || !isRecord(value.appliedFormat)) {
    throw invalidResult('格式写入结果无效')
  }
  const warnings = safeStringArray(value.warnings)
  return Object.freeze({
    applied: value.applied === true,
    saved: value.saved === true,
    revision: requiredRevision(value.revision),
    sheet: requiredString(value.sheet),
    range: requiredString(value.range),
    rowCount: requiredPositiveInteger(value.rowCount),
    columnCount: requiredPositiveInteger(value.columnCount),
    changedCells: requiredNonnegativeInteger(value.changedCells),
    appliedFormat: sanitizeFormat(value.appliedFormat),
    previewConfirmed: value.previewConfirmed === true,
    ...(warnings ? { warnings } : {}),
    ...(value.deduplicated === true ? { deduplicated: true as const } : {}),
    ...(value.reconciled === true ? { reconciled: true as const } : {})
  })
}

export function sanitizeFailureResult(
  error: OfficeWriteError
): OfficeWriteReceiptResult | undefined {
  const result = error.details?.result
  if (!isRecord(result)) return undefined
  try {
    if (error.code === 'formula_invalid') return sanitizeFormulaInvalidResult(result)
    if (error.code !== 'save_failed') return undefined
    if (Object.hasOwn(result, 'slideId')) return sanitizePptxWriteResult(result)
    if (Object.hasOwn(result, 'paraId')) return sanitizeDocxWriteResult(result)
    const safe = Object.hasOwn(result, 'sheetNames')
      ? sanitizeAddSheetResult(result)
      : Object.hasOwn(result, 'appliedFormat')
        ? sanitizeFormatRangeResult(result)
        : Object.hasOwn(result, 'range')
          ? sanitizeRangeEditResult(result)
          : Object.hasOwn(result, 'formula')
            ? sanitizeFormulaEditResult(result)
            : sanitizeCellEditResult(result)
    return safe.applied === true && safe.saved === false ? safe : undefined
  } catch {
    return undefined
  }
}

export function safeWriteMessage(code: OfficeWriteError['code']): string {
  if (code === 'no_target') return OFFICE_NO_TARGET_MESSAGE
  if (code === 'missing_operation_id') return '写入请求缺少可信操作编号，未做任何修改'
  if (code === 'operation_conflict') return '操作编号已用于不同的写入请求，未做任何修改'
  if (code === 'operation_log_corrupt') return '写入记录无法验证，文档已冻结等待核对'
  if (code === 'approval_changed') return '写入参数未获本次批准，未做任何修改'
  if (code === 'revision_conflict') return '文档已更新，请先重新读取后再修改'
  if (code === 'formula_not_supported') return '字面 = 文本当前不支持；要写公式请使用 set_formula'
  if (code === 'formula_invalid') return '公式无法可靠计算，已恢复写入前内容'
  if (code === 'document_frozen') {
    return '该文档有待核对的写入结果，已尝试自动核对；请告知用户在右侧面板点击“重新核对”，不要重复写入'
  }
  if (code === 'unsupported_document_kind') {
    return '当前关联的是 PowerPoint 演示文稿，暂不支持通过工具读取/修改（后续版本支持）'
  }
  if (code === 'write_unknown' || code === 'write_verification_failed') {
    return '写入结果无法确认，文档已冻结等待核对'
  }
  if (code === 'write_cancelled') return '写入已取消，文档未修改'
  if (code === 'save_failed') return '内容已写入，但 Office 草稿保存失败'
  if (code === 'write_not_applied') return '已核对该次写入未生效，可用新的调用重试'
  if (code === 'reconcile_indeterminate') return '核对后仍无法确认写入结果，文档继续冻结'
  if (code === 'reconcile_failed') return '核对未能可靠完成，文档继续冻结'
  if (code === 'invalid_sheet') return '工作表名称无效'
  if (code === 'sheet_exists') return '工作表名称已存在，请改用其它名称'
  if (code === 'too_many_sheets') return '每个工作簿最多 20 个工作表'
  if (code === 'invalid_cell') return '单元格必须使用有效的单个 A1 地址'
  if (code === 'invalid_value') return '值或行优先矩阵尺寸无效，请核对范围与 values'
  if (code === 'range_out_of_bounds') return '写入范围超出准入边界，请缩小到 A1:J1000 内'
  if (code === 'range_too_large') return '写入范围或命令体过大，请缩小到 2000 格和 256 KiB 以内'
  if (code === 'target_missing') return '关联的 Office 文档已不可用'
  if (code === 'session_mismatch') return '关联的 Office 文档不属于当前会话'
  return 'Office 未能可靠写入该单元格'
}

function sanitizeAddSheetDescription(value: unknown): OfficeAddSheetDescription {
  if (!isRecord(value) || value.type !== 'add_sheet') {
    throw invalidResult('新建工作表说明无效')
  }
  return Object.freeze({
    type: 'add_sheet',
    documentName: requiredString(value.documentName),
    name: requiredString(value.name),
    sheetCount: requiredNonnegativeInteger(value.sheetCount),
    revision: requiredRevision(value.revision)
  })
}

function sanitizeRangeEditDescription(value: unknown): OfficeRangeEditDescription {
  if (!isRecord(value) || value.type !== 'set_range') throw invalidResult('范围写入说明无效')
  return Object.freeze({
    type: 'set_range',
    documentName: requiredString(value.documentName),
    sheet: requiredString(value.sheet),
    range: requiredString(value.range),
    rowCount: requiredPositiveInteger(value.rowCount),
    columnCount: requiredPositiveInteger(value.columnCount),
    cellCount: requiredPositiveInteger(value.cellCount),
    changedCells: requiredNonnegativeInteger(value.changedCells),
    preview: safeRangePreview(value.preview),
    revision: requiredRevision(value.revision)
  })
}

function sanitizeFormatRangeDescription(value: unknown): OfficeFormatRangeDescription {
  if (!isRecord(value) || value.type !== 'format_range' || !isRecord(value.format)) {
    throw invalidResult('格式写入说明无效')
  }
  return Object.freeze({
    type: 'format_range',
    documentName: requiredString(value.documentName),
    sheet: requiredString(value.sheet),
    range: requiredString(value.range),
    rowCount: requiredPositiveInteger(value.rowCount),
    columnCount: requiredPositiveInteger(value.columnCount),
    cellCount: requiredPositiveInteger(value.cellCount),
    changedCells: requiredNonnegativeInteger(value.changedCells),
    format: sanitizeFormat(value.format),
    revision: requiredRevision(value.revision)
  })
}

function sanitizeFormat(value: Record<string, unknown>): OfficeRangeFormat {
  if (
    Object.keys(value).length === 0 ||
    !Object.keys(value).every((key) =>
      ['bold', 'fill', 'horizontalAlign', 'numberFormat'].includes(key)
    ) ||
    (value.bold !== undefined && typeof value.bold !== 'boolean') ||
    (value.fill !== undefined &&
      (typeof value.fill !== 'string' || !/^#[0-9A-F]{6}$/u.test(value.fill))) ||
    (value.horizontalAlign !== undefined &&
      !['left', 'center', 'right'].includes(String(value.horizontalAlign))) ||
    (value.numberFormat !== undefined &&
      !['General', '0', '0.00', '#,##0', '#,##0.00'].includes(String(value.numberFormat)))
  ) {
    throw invalidResult('格式写入结果无效')
  }
  return Object.freeze({ ...value }) as OfficeRangeFormat
}

function safeRangePreview(value: unknown): readonly OfficeRangePreviewCell[] {
  if (!Array.isArray(value) || value.length > 6) throw invalidResult('范围写入结果无效')
  return Object.freeze(
    value.map((entry) => {
      if (!isRecord(entry)) throw invalidResult('范围写入结果无效')
      return Object.freeze({
        cell: requiredString(entry.cell),
        before: requiredCellValue(entry.before, true),
        after: requiredCellValue(entry.after, false)
      })
    })
  )
}

function requiredPositiveInteger(value: unknown): number {
  const parsed = requiredRevision(value)
  if (parsed === 0) throw invalidResult('范围写入结果无效')
  return parsed
}

function requiredNonnegativeInteger(value: unknown): number {
  return requiredRevision(value)
}

function requiredHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw invalidResult('范围写入结果无效')
  }
  return value
}

function requiredRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidResult('写入结果无效')
  }
  return value
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw invalidResult('写入结果无效')
  return value
}

function requiredCellValue(value: unknown, allowNull: false): OfficeCellValue
function requiredCellValue(value: unknown, allowNull: true): OfficeCellValue | null
function requiredCellValue(value: unknown, allowNull: boolean): OfficeCellValue | null {
  if (allowNull && value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw invalidResult('写入结果无效')
}

function safeStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined
  return Object.freeze([...value])
}

function invalidResult(message: string): OfficeWriteError {
  return new OfficeWriteError('write_failed', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
