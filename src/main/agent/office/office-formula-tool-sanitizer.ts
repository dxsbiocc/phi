import {
  OfficeWriteError,
  type OfficeCellValue,
  type OfficeFormulaEditDescription,
  type OfficeFormulaEditResult,
  type OfficeFormulaInvalidReason,
  type OfficeFormulaInvalidResult,
  type OfficeWriteSnapshotCell
} from './office-write-contract'

export function sanitizeFormulaEditDescription(value: unknown): OfficeFormulaEditDescription {
  if (!isRecord(value) || value.type !== 'set_formula' || !isRecord(value.before)) {
    throw invalidFormulaResult()
  }
  return Object.freeze({
    type: 'set_formula',
    documentName: requiredString(value.documentName),
    sheet: requiredString(value.sheet),
    cell: requiredString(value.cell),
    formula: requiredFormula(value.formula),
    before: Object.freeze({
      value: requiredCellValue(value.before.value, true),
      valueType: requiredValueType(value.before.valueType),
      ...(value.before.formula === undefined
        ? {}
        : { formula: requiredFormula(value.before.formula) }),
      ...(value.before.evaluated === undefined
        ? {}
        : { evaluated: requiredBoolean(value.before.evaluated) })
    }),
    revision: requiredRevision(value.revision)
  })
}

export function sanitizeFormulaEditResult(value: unknown): OfficeFormulaEditResult {
  if (!isRecord(value) || value.applied !== true) throw invalidFormulaResult()
  return Object.freeze({
    applied: true,
    saved: value.saved === true,
    revision: requiredRevision(value.revision),
    sheet: requiredString(value.sheet),
    cell: requiredString(value.cell),
    formula: requiredFormula(value.formula),
    computedValue: requiredCellValue(value.computedValue, false),
    valueType: requiredComputedValueType(value.valueType),
    previewConfirmed: value.previewConfirmed === true,
    ...(safeStringArray(value.warnings) ? { warnings: safeStringArray(value.warnings) } : {}),
    ...(value.deduplicated === true ? { deduplicated: true as const } : {}),
    ...(value.reconciled === true ? { reconciled: true as const } : {})
  })
}

export function sanitizeFormulaInvalidResult(value: unknown): OfficeFormulaInvalidResult {
  if (
    !isRecord(value) ||
    value.applied !== false ||
    value.saved !== true ||
    value.previewConfirmed !== false ||
    !isRecord(value.formulaStatus) ||
    !isFormulaInvalidReason(value.reason)
  ) {
    throw invalidFormulaResult()
  }
  return Object.freeze({
    applied: false,
    saved: true,
    revision: requiredRevision(value.revision),
    sheet: requiredString(value.sheet),
    cell: requiredString(value.cell),
    formula: requiredFormula(value.formula),
    formulaStatus: Object.freeze({
      ...(value.formulaStatus.formula === undefined
        ? {}
        : { formula: requiredFormula(value.formulaStatus.formula) }),
      evaluated: requiredBoolean(value.formulaStatus.evaluated),
      computedValue: requiredCellValue(value.formulaStatus.computedValue, true),
      valueType: requiredValueType(value.formulaStatus.valueType)
    }),
    reason: value.reason,
    previewConfirmed: false,
    ...(value.deduplicated === true ? { deduplicated: true as const } : {})
  })
}

function requiredFormula(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    value.length > 8_192 ||
    !value.startsWith('=') ||
    [...value].some(isControlCharacter)
  ) {
    throw invalidFormulaResult()
  }
  return value
}

function requiredCellValue(value: unknown, allowNull: false): OfficeCellValue
function requiredCellValue(value: unknown, allowNull: true): OfficeCellValue | null
function requiredCellValue(value: unknown, allowNull: boolean): OfficeCellValue | null {
  if (allowNull && value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw invalidFormulaResult()
}

function requiredValueType(value: unknown): OfficeWriteSnapshotCell['valueType'] {
  if (
    !['empty', 'string', 'number', 'boolean', 'date', 'error', 'unknown'].includes(String(value))
  ) {
    throw invalidFormulaResult()
  }
  return value as OfficeWriteSnapshotCell['valueType']
}

function requiredComputedValueType(value: unknown): OfficeWriteSnapshotCell['valueType'] {
  const parsed = requiredValueType(value)
  if (parsed === 'empty' || parsed === 'error') throw invalidFormulaResult()
  return parsed
}

function requiredRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidFormulaResult()
  }
  return value
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw invalidFormulaResult()
  return value
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidFormulaResult()
  return value
}

function safeStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined
  return Object.freeze([...value])
}

function isFormulaInvalidReason(value: unknown): value is OfficeFormulaInvalidReason {
  return [
    'formula_mismatch',
    'invalid_syntax',
    'unsupported_function',
    'not_evaluated',
    'error_value',
    'circular_reference',
    'reference_graph_too_large'
  ].includes(String(value))
}

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0)
  return code < 32 || code === 127 || (code >= 0x80 && code <= 0x9f)
}

function invalidFormulaResult(): OfficeWriteError {
  return new OfficeWriteError('write_failed', '公式写入结果无效')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
