import { OFFICE_DOCUMENT_LIMITS } from './office-limits'
import { OfficeWriteError } from './office-write-contract'

export interface OfficeAddParagraphOperation {
  readonly type: 'add_paragraph'
  readonly text: string
  readonly position?: 'end' | Readonly<{ after: string }>
}

export interface OfficeSetParagraphTextOperation {
  readonly type: 'set_paragraph_text'
  readonly paraId: string
  readonly text: string
  readonly expectedText?: string
}

export type OfficeDocxOperation = OfficeAddParagraphOperation | OfficeSetParagraphTextOperation

export interface OfficeDocxParagraphSnapshot {
  readonly paraId: string
  readonly index: number
  readonly text: string
  readonly style?: string
  readonly editable: boolean
}

export interface OfficeDocxSnapshot {
  readonly paragraphs: readonly OfficeDocxParagraphSnapshot[]
  readonly paragraphCount: number
}

export interface OfficeAddParagraphBefore {
  readonly type: 'add_paragraph'
  readonly paragraphCount: number
  readonly anchorParaId?: string
  readonly previousParaId?: string
}

export interface OfficeSetParagraphTextBefore {
  readonly type: 'set_paragraph_text'
  readonly paraId: string
  readonly text: string
}

export type OfficeDocxBefore = OfficeAddParagraphBefore | OfficeSetParagraphTextBefore

export interface OfficeAddParagraphReceipt {
  readonly type: 'add_paragraph'
  readonly paraId: string
  readonly path: string
}

export interface OfficeSetParagraphTextReceipt {
  readonly type: 'set_paragraph_text'
  readonly paraId: string
  readonly path: string
}

export type OfficeDocxWriteReceipt = OfficeAddParagraphReceipt | OfficeSetParagraphTextReceipt

export function captureOfficeDocxBefore(
  operation: OfficeDocxOperation,
  snapshot: OfficeDocxSnapshot
): OfficeDocxBefore {
  if (operation.type === 'set_paragraph_text') {
    const paragraph = requireTargetParagraph(operation, snapshot)
    return Object.freeze({ type: operation.type, paraId: operation.paraId, text: paragraph.text })
  }
  const anchorParaId =
    operation.position !== undefined && operation.position !== 'end'
      ? operation.position.after
      : undefined
  if (anchorParaId && !snapshot.paragraphs.some((entry) => entry.paraId === anchorParaId)) {
    throw paragraphNotFound()
  }
  const previousParaId = anchorParaId ?? snapshot.paragraphs.at(-1)?.paraId
  return Object.freeze({
    type: operation.type,
    paragraphCount: snapshot.paragraphCount,
    ...(anchorParaId ? { anchorParaId } : {}),
    ...(previousParaId ? { previousParaId } : {})
  })
}

export function assertOfficeDocxTarget(
  operation: OfficeDocxOperation,
  snapshot: OfficeDocxSnapshot
): void {
  if (operation.type === 'add_paragraph') {
    captureOfficeDocxBefore(operation, snapshot)
    return
  }
  requireTargetParagraph(operation, snapshot)
}

export function validateOfficeDocxOperation(value: unknown): OfficeDocxOperation {
  if (!isRecord(value) || typeof value.type !== 'string') throw invalidOperation()
  if (value.type === 'add_paragraph') return validateAddParagraph(value)
  if (value.type === 'set_paragraph_text') return validateSetParagraphText(value)
  throw invalidOperation()
}

function validateAddParagraph(value: Record<string, unknown>): OfficeAddParagraphOperation {
  assertOnlyKeys(value, ['type', 'text', 'position'])
  const text = validateNewText(value.text)
  const position = validatePosition(value.position)
  return Object.freeze({
    type: 'add_paragraph',
    text,
    ...(position === undefined ? {} : { position })
  })
}

function validateSetParagraphText(value: Record<string, unknown>): OfficeSetParagraphTextOperation {
  assertOnlyKeys(value, ['type', 'paraId', 'text', 'expectedText'])
  const paraId = normalizeParaId(value.paraId)
  const text = validateNewText(value.text)
  const expectedText = validateExpectedText(value.expectedText)
  return Object.freeze({
    type: 'set_paragraph_text',
    paraId,
    text,
    ...(expectedText === undefined ? {} : { expectedText })
  })
}

function validatePosition(value: unknown): OfficeAddParagraphOperation['position'] {
  if (value === undefined || value === 'end') return value
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'after')) {
    throw invalidOperation()
  }
  return Object.freeze({ after: normalizeParaId(value.after) })
}

function validateNewText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > OFFICE_DOCUMENT_LIMITS.maxParagraphTextLength ||
    hasUnsupportedText(value)
  ) {
    throw new OfficeWriteError('invalid_value', '段落文本长度无效或包含不支持的控制字符')
  }
  return value
}

function validateExpectedText(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length > OFFICE_DOCUMENT_LIMITS.maxParagraphTextLength ||
    hasUnsupportedText(value)
  ) {
    throw new OfficeWriteError('invalid_value', '预期段落文本无效')
  }
  return value
}

function hasUnsupportedText(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code === 10 || code === 13 || (code < 32 && code !== 9)) return true
    if (code === 127 || (code >= 0x80 && code <= 0x9f)) return true
  }
  return false
}

export function normalizeOfficeParaId(value: unknown): string {
  return normalizeParaId(value)
}

function normalizeParaId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9A-F]{8}$/iu.test(value)) {
    throw new OfficeWriteError('invalid_value', '段落定位编号无效')
  }
  return value.toUpperCase()
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalidOperation()
}

function invalidOperation(): OfficeWriteError {
  return new OfficeWriteError('invalid_value', 'Word 段落写入操作无效')
}

function requireTargetParagraph(
  operation: OfficeSetParagraphTextOperation,
  snapshot: OfficeDocxSnapshot
): OfficeDocxParagraphSnapshot {
  const paragraph = snapshot.paragraphs.find((entry) => entry.paraId === operation.paraId)
  if (!paragraph) throw paragraphNotFound()
  if (!paragraph.editable) {
    throw new OfficeWriteError(
      'paragraph_not_plain',
      '目标段落包含多个文本片段或复杂内容，不能安全修改'
    )
  }
  if (operation.expectedText !== undefined && operation.expectedText !== paragraph.text) {
    throw new OfficeWriteError('stale_target', '目标段落已变化，请重新读取后再修改')
  }
  return paragraph
}

function paragraphNotFound(): OfficeWriteError {
  return new OfficeWriteError('paragraph_not_found', '目标段落不存在，请重新读取文档')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
