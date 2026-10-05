import { detectOfficeFormulaCycle, type OfficeFormulaReader } from './office-formula-cycle'
import { formulaInvalidState, formulaStatusFromSnapshot } from './office-formula-operation'
import {
  OfficeWriteError,
  type OfficeFormulaInvalidReason,
  type OfficeFormulaInvalidResult,
  type OfficeFormulaStatus,
  type OfficeSetFormulaOperation,
  type OfficeWriteRequest,
  type OfficeWriteSnapshot
} from './office-write-contract'

export interface OfficeFormulaFailure {
  readonly formulaStatus: OfficeFormulaStatus
  readonly reason: OfficeFormulaInvalidReason
}

export async function formulaFailure(
  request: OfficeWriteRequest,
  snapshot: OfficeWriteSnapshot,
  readCellFormula: OfficeFormulaReader
): Promise<OfficeFormulaFailure | undefined> {
  if (request.operation.type !== 'set_formula') return undefined
  const invalid = formulaInvalidState(request.operation, snapshot)
  if (invalid) return invalid
  let cycle: Awaited<ReturnType<typeof detectOfficeFormulaCycle>>
  try {
    cycle = await detectOfficeFormulaCycle(request.operation, readCellFormula)
  } catch {
    cycle = 'reference_graph_too_large'
  }
  return cycle ? { formulaStatus: formulaStatusFromSnapshot(snapshot), reason: cycle } : undefined
}

export function formulaInvalidError(
  operation: OfficeSetFormulaOperation,
  revision: number,
  failure: OfficeFormulaFailure
): OfficeWriteError {
  const result: OfficeFormulaInvalidResult = Object.freeze({
    applied: false,
    saved: true,
    revision,
    sheet: operation.sheet,
    cell: operation.cell,
    formula: operation.formula,
    formulaStatus: failure.formulaStatus,
    reason: failure.reason,
    previewConfirmed: false
  })
  return new OfficeWriteError('formula_invalid', formulaFailureMessage(failure.reason), { result })
}

function formulaFailureMessage(reason: OfficeFormulaInvalidReason): string {
  if (reason === 'unsupported_function') {
    return '该函数暂不被 Phi 的计算引擎支持，请改用常用函数或拆分计算'
  }
  if (reason === 'circular_reference') return '公式包含循环引用，已恢复写入前内容'
  if (reason === 'reference_graph_too_large') return '公式引用关系过大，无法安全验证'
  if (reason === 'invalid_syntax') return '公式括号或引号不完整，已恢复写入前内容'
  if (reason === 'formula_mismatch') return '公式读回与写入内容不一致，已恢复写入前内容'
  if (reason === 'not_evaluated') return '公式未能完成计算，已恢复写入前内容'
  return '公式计算得到错误值，已恢复写入前内容'
}
