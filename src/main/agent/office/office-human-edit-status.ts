import type { OfficeHumanWriteOperation } from './office-human-edit-translate'
export type OfficeHumanEditValueType = 'text' | 'number' | 'boolean' | 'formula' | 'clear'

export interface OfficeHumanEditSummary {
  readonly type: OfficeHumanEditValueType
  readonly conclusion: 'succeeded' | 'failed'
  readonly code: string
  readonly message: string
}

export function successfulHumanEdit(operation: OfficeHumanWriteOperation): OfficeHumanEditSummary {
  return Object.freeze({
    type: humanEditType(operation),
    conclusion: 'succeeded',
    code: 'ok',
    message: '单元格已更新'
  })
}

export function failedHumanEdit(
  operation: OfficeHumanWriteOperation | undefined,
  error: unknown
): OfficeHumanEditSummary {
  const code = knownErrorCode(error)
  return Object.freeze({
    type: operation ? humanEditType(operation) : 'text',
    conclusion: 'failed',
    code,
    message: humanEditFailureMessage(code, error)
  })
}

function humanEditType(operation: OfficeHumanWriteOperation): OfficeHumanEditValueType {
  if (operation.type === 'clear_cell') return 'clear'
  if (operation.type === 'set_formula') return 'formula'
  if (typeof operation.value === 'number') return 'number'
  if (typeof operation.value === 'boolean') return 'boolean'
  return 'text'
}

function knownErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' ? code : 'write_failed'
}

function humanEditFailureMessage(code: string, error: unknown): string {
  if (code === 'document_frozen') return '文档有待核对的写入结果，暂不能编辑'
  if (code === 'document_read_only') return '该文档为只读，不能编辑'
  if (code === 'formula_invalid') return `公式无法计算，已撤销：${formulaReason(error)}`
  if (code === 'invalid_sheet') return '指定的工作表不存在或名称无效'
  if (code === 'invalid_cell' || code === 'range_out_of_bounds') return '单元格地址超出可编辑范围'
  if (code === 'invalid_value' || code === 'formula_not_supported')
    return '输入内容不符合单元格编辑规则'
  if (code === 'save_failed') return '内容已写入，但草稿保存失败'
  if (code === 'write_unknown' || code === 'write_verification_failed') {
    return '写入结果无法确认，文档已冻结等待核对'
  }
  return '单元格编辑失败，已恢复真实内容'
}

function formulaReason(error: unknown): string {
  const reason = (error as { details?: { result?: { reason?: unknown } } })?.details?.result?.reason
  if (reason === 'invalid_syntax') return '括号或引号不完整'
  if (reason === 'unsupported_function') return '函数暂不受支持'
  if (reason === 'circular_reference') return '检测到循环引用'
  return '计算结果未通过验证'
}
