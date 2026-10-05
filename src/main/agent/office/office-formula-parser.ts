import { OFFICE_FORMULA_LIMITS } from './office-limits'
import {
  normalizeOfficeWriteRevision,
  normalizeOfficeWriteTarget,
  OfficeWriteError,
  type OfficeFormulaEditParams
} from './office-write-contract'

const FORMULA_PARAM_KEYS = new Set(['sheet', 'cell', 'formula', 'baseRevision'])

export function validateFormulaEditParams(params: unknown): OfficeFormulaEditParams {
  if (!isRecord(params) || Object.keys(params).some((key) => !FORMULA_PARAM_KEYS.has(key))) {
    throw new OfficeWriteError('invalid_value', '公式写入参数字段无效')
  }
  const target = normalizeOfficeWriteTarget(params.sheet, params.cell)
  const formula = validatedFormula(params.formula)
  return Object.freeze({
    ...target,
    formula,
    baseRevision: normalizeOfficeWriteRevision(params.baseRevision)
  })
}

export function hasBalancedFormulaDelimiters(formula: string): boolean {
  let parentheses = 0
  let stringQuoted = false
  let sheetQuoted = false
  for (let index = formula.startsWith('=') ? 1 : 0; index < formula.length; index += 1) {
    const character = formula[index]!
    if (stringQuoted) {
      if (character !== '"') continue
      if (formula[index + 1] === '"') index += 1
      else stringQuoted = false
      continue
    }
    if (sheetQuoted) {
      if (character !== "'") continue
      if (formula[index + 1] === "'") index += 1
      else sheetQuoted = false
      continue
    }
    if (character === '"') stringQuoted = true
    else if (character === "'") sheetQuoted = true
    else if (character === '(') parentheses += 1
    else if (character === ')' && parentheses-- === 0) return false
  }
  return parentheses === 0 && !stringQuoted && !sheetQuoted
}

function validatedFormula(formula: unknown): string {
  if (
    typeof formula !== 'string' ||
    !formula.startsWith('=') ||
    formula.length < 2 ||
    formula.length > OFFICE_FORMULA_LIMITS.maxLength
  ) {
    throw new OfficeWriteError('invalid_value', '公式必须以 = 开头且长度为 2 到 8192 个字符')
  }
  if ([...formula].some(isControlCharacter)) {
    throw new OfficeWriteError('invalid_value', '公式不能包含控制字符')
  }
  return formula
}

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0)
  return code < 32 || code === 127 || (code >= 0x80 && code <= 0x9f)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
