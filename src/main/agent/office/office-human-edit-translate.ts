import type {
  OfficeClearCellOperation,
  OfficeSetCellOperation,
  OfficeSetFormulaOperation
} from './office-write-contract'
import { OfficeWriteError } from './office-write-contract'

const STRICT_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/

export type OfficeHumanWriteOperation =
  OfficeSetCellOperation | OfficeSetFormulaOperation | OfficeClearCellOperation

export interface OfficeHumanCellTextInput {
  readonly sheet: string
  readonly cell: string
  readonly text: string
}

export function translateOfficeHumanCellText(
  input: OfficeHumanCellTextInput
): OfficeHumanWriteOperation {
  if (!isValidInput(input)) {
    throw new OfficeWriteError('invalid_value', '人工单元格编辑参数无效')
  }
  const target = { sheet: input.sheet, cell: input.cell }
  if (input.text === '') return Object.freeze({ type: 'clear_cell', ...target })
  if (input.text.startsWith('=')) {
    return Object.freeze({ type: 'set_formula', ...target, formula: input.text })
  }
  if (input.text === 'TRUE' || input.text === 'FALSE') {
    return Object.freeze({ type: 'set_cell', ...target, value: input.text === 'TRUE' })
  }
  if (STRICT_NUMBER.test(input.text)) {
    const value = Number(input.text)
    if (Number.isFinite(value)) return Object.freeze({ type: 'set_cell', ...target, value })
    throw new OfficeWriteError('invalid_value', '单元格数值超出可表示范围')
  }
  return Object.freeze({ type: 'set_cell', ...target, value: input.text })
}

function isValidInput(input: unknown): input is OfficeHumanCellTextInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  return (
    Object.keys(record).length === 3 &&
    Object.hasOwn(record, 'sheet') &&
    Object.hasOwn(record, 'cell') &&
    Object.hasOwn(record, 'text') &&
    typeof record.sheet === 'string' &&
    typeof record.cell === 'string' &&
    typeof record.text === 'string'
  )
}
