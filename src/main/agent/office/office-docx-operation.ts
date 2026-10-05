import {
  assertOfficeDocxTarget,
  captureOfficeDocxBefore,
  normalizeOfficeParaId,
  validateOfficeDocxOperation,
  type OfficeDocxBefore,
  type OfficeDocxOperation,
  type OfficeDocxParagraphSnapshot,
  type OfficeDocxSnapshot
} from './office-docx-contract'
import { visibleText } from './office-approval-summary'
import {
  normalizeOfficeWriteRevision,
  OfficeWriteError,
  type OfficeAddParagraphDescription,
  type OfficeAddParagraphResult,
  type OfficeDocxWriteDescription,
  type OfficeDocxWriteResult,
  type OfficeSetParagraphTextDescription,
  type OfficeSetParagraphTextResult,
  type OfficeWriteBefore,
  type OfficeWriteRequest,
  type OfficeWriteSnapshot
} from './office-write-contract'
import type { OfficeWriteOperationStrategy } from './office-write-operation-types'

export const addParagraphStrategy = strategyFor('add_paragraph')
export const setParagraphTextStrategy = strategyFor('set_paragraph_text')

function strategyFor(type: OfficeDocxOperation['type']): OfficeWriteOperationStrategy {
  return {
    type,
    documentKind: 'docx',
    ...operationCore(type),
    ...operationPresentation()
  }
}

function operationCore(
  type: OfficeDocxOperation['type']
): Pick<
  OfficeWriteOperationStrategy,
  | 'validate'
  | 'digestInput'
  | 'affectedCells'
  | 'readRange'
  | 'expected'
  | 'commands'
  | 'previewCondition'
  | 'assertBefore'
  | 'snapshot'
  | 'verify'
> {
  return {
    validate(operation, baseRevision) {
      const normalized = validateOfficeDocxOperation(operation)
      if (normalized.type !== type) throw invalidOperation()
      return Object.freeze({
        operation: normalized,
        baseRevision: normalizeOfficeWriteRevision(baseRevision)
      })
    },
    digestInput(request) {
      return { operation: request.operation, baseRevision: request.baseRevision }
    },
    affectedCells: () => [],
    readRange: () => '',
    expected(operation, before) {
      return expectedSnapshot(operation as OfficeDocxOperation, before)
    },
    commands: () => {
      throw new OfficeWriteError(
        'operation_not_supported_for_kind',
        'Word 段落操作不能通过表格批处理执行'
      )
    },
    previewCondition(operation) {
      return { kind: 'document', text: (operation as OfficeDocxOperation).text }
    },
    assertBefore(operation, before) {
      assertOfficeDocxTarget(operation as OfficeDocxOperation, requireSnapshot(before))
    },
    snapshot: () => {
      throw new OfficeWriteError('write_failed', 'Word 段落不能从单元格快照构造')
    },
    verify(operation, before, current) {
      return classify(operation as OfficeDocxOperation, before, current) !== 'indeterminate'
    }
  }
}

function operationPresentation(): Pick<
  OfficeWriteOperationStrategy,
  'before' | 'restoreBefore' | 'describe' | 'approvalSummary' | 'result' | 'classify'
> {
  return {
    before(operation, snapshot) {
      return captureOfficeDocxBefore(operation as OfficeDocxOperation, requireSnapshot(snapshot))
    },
    restoreBefore(operation, before) {
      return restoreBefore(operation as OfficeDocxOperation, before)
    },
    describe(request, before, documentName, revision) {
      return describe(request, requireSnapshot(before), documentName, revision)
    },
    approvalSummary(description) {
      return approvalSummary(description as OfficeDocxWriteDescription)
    },
    result(request, before, revision, saved, previewConfirmed, verified) {
      return result(
        request,
        before.docx ?? beforeFromEvidence(before.docxBefore),
        requireSnapshot(verified),
        revision,
        saved,
        previewConfirmed
      )
    },
    classify(operation, before, current) {
      return classify(operation as OfficeDocxOperation, before, current)
    }
  }
}

function describe(
  request: OfficeWriteRequest,
  before: OfficeDocxSnapshot,
  documentName: string,
  revision: number
): OfficeDocxWriteDescription {
  const operation = request.operation as OfficeDocxOperation
  if (operation.type === 'add_paragraph') {
    const anchor =
      operation.position !== undefined && operation.position !== 'end'
        ? operation.position.after
        : undefined
    const index = anchor
      ? before.paragraphs.findIndex((paragraph) => paragraph.paraId === anchor) + 1
      : before.paragraphCount
    return Object.freeze({
      type: operation.type,
      documentName,
      text: operation.text,
      position: anchor ? { after: anchor, index } : 'end',
      revision
    }) satisfies OfficeAddParagraphDescription
  }
  const paragraph = requireParagraph(before, operation.paraId)
  return Object.freeze({
    type: operation.type,
    documentName,
    paraId: operation.paraId,
    index: paragraph.index,
    before: paragraph.text,
    after: operation.text,
    revision
  }) satisfies OfficeSetParagraphTextDescription
}

function approvalSummary(description: OfficeDocxWriteDescription): string {
  if (description.type === 'add_paragraph') {
    const target =
      description.position === 'end'
        ? '文档末尾'
        : `第 ${description.position.index + 1} 段之后（${description.position.after}）`
    return `新增段落到${target}：「${visibleText(description.text)}」（文档：${visibleText(description.documentName)}）`
  }
  return `修改第 ${description.index + 1} 段（${description.paraId}）：「${visibleText(description.before)}」→「${visibleText(description.after)}」（文档：${visibleText(description.documentName)}）`
}

function result(
  request: OfficeWriteRequest,
  before: OfficeDocxSnapshot,
  current: OfficeDocxSnapshot,
  revision: number,
  saved: boolean,
  previewConfirmed: boolean
): OfficeDocxWriteResult {
  const operation = request.operation as OfficeDocxOperation
  const warnings = previewConfirmed ? {} : { warnings: Object.freeze(['preview_not_confirmed']) }
  if (operation.type === 'add_paragraph') {
    const paragraph = addedParagraph(operation, before, current)
    return Object.freeze({
      applied: true,
      saved,
      revision,
      paraId: paragraph.paraId,
      path: paragraphPath(paragraph.paraId),
      index: paragraph.index,
      text: paragraph.text,
      previewConfirmed,
      ...warnings
    }) satisfies OfficeAddParagraphResult
  }
  const paragraph = requireParagraph(current, operation.paraId)
  const old = requireParagraph(before, operation.paraId)
  return Object.freeze({
    applied: true,
    saved,
    revision,
    paraId: paragraph.paraId,
    path: paragraphPath(paragraph.paraId),
    index: paragraph.index,
    before: old.text,
    after: paragraph.text,
    previewConfirmed,
    ...warnings
  }) satisfies OfficeSetParagraphTextResult
}

function classify(
  operation: OfficeDocxOperation,
  before: OfficeWriteSnapshot,
  current: OfficeWriteSnapshot
): 'applied' | 'not_applied' | 'indeterminate' | 'applied_no_change' {
  const old = before.docx ?? beforeFromEvidence(before.docxBefore)
  const next = current.docx
  if (!next) return 'indeterminate'
  if (operation.type === 'add_paragraph') {
    if (next.paragraphCount === old.paragraphCount) return 'not_applied'
    if (next.paragraphCount !== old.paragraphCount + 1) return 'indeterminate'
    return addedParagraphOrUndefined(operation, old, next) ? 'applied' : 'indeterminate'
  }
  const previous = requireParagraphOrUndefined(old, operation.paraId)
  const paragraph = requireParagraphOrUndefined(next, operation.paraId)
  if (!previous || !paragraph) return 'indeterminate'
  if (paragraph.text === operation.text) {
    return previous.text === operation.text ? 'applied_no_change' : 'applied'
  }
  return paragraph.text === previous.text ? 'not_applied' : 'indeterminate'
}

function restoreBefore(
  operation: OfficeDocxOperation,
  value: OfficeWriteBefore
): OfficeWriteSnapshot {
  if (!isRecord(value)) throw invalidEvidence()
  const stored = value as Record<string, unknown>
  if (stored.type !== operation.type) throw invalidEvidence()
  if (operation.type === 'add_paragraph') {
    if (!validCount(stored.paragraphCount)) throw invalidEvidence()
    const before: OfficeDocxBefore = {
      type: operation.type,
      paragraphCount: stored.paragraphCount,
      ...(typeof stored.anchorParaId === 'string'
        ? { anchorParaId: normalizeOfficeParaId(stored.anchorParaId) }
        : {}),
      ...(typeof stored.previousParaId === 'string'
        ? { previousParaId: normalizeOfficeParaId(stored.previousParaId) }
        : {})
    }
    return snapshotWithEvidence(before)
  }
  if (
    typeof stored.text !== 'string' ||
    normalizeOfficeParaId(stored.paraId) !== operation.paraId
  ) {
    throw invalidEvidence()
  }
  const before: OfficeDocxBefore = {
    type: operation.type,
    paraId: operation.paraId,
    text: stored.text
  }
  return snapshotWithEvidence(before)
}

function expectedSnapshot(
  operation: OfficeDocxOperation,
  before?: OfficeWriteSnapshot
): OfficeWriteSnapshot {
  if (operation.type === 'set_paragraph_text') {
    const old = requireSnapshot(before)
    const paragraphs = old.paragraphs.map((paragraph) =>
      paragraph.paraId === operation.paraId ? { ...paragraph, text: operation.text } : paragraph
    )
    return wrapSnapshot({ paragraphs, paragraphCount: old.paragraphCount })
  }
  return before ?? snapshotWithEvidence({ type: 'add_paragraph', paragraphCount: 0 })
}

function addedParagraph(
  operation: Extract<OfficeDocxOperation, { type: 'add_paragraph' }>,
  before: OfficeDocxSnapshot,
  current: OfficeDocxSnapshot
): OfficeDocxSnapshot['paragraphs'][number] {
  const paragraph = addedParagraphOrUndefined(operation, before, current)
  if (!paragraph) throw new OfficeWriteError('write_verification_failed', '新增段落读回不一致')
  return paragraph
}

function addedParagraphOrUndefined(
  operation: Extract<OfficeDocxOperation, { type: 'add_paragraph' }>,
  before: OfficeDocxSnapshot,
  current: OfficeDocxSnapshot
): OfficeDocxSnapshot['paragraphs'][number] | undefined {
  const anchor =
    operation.position !== undefined && operation.position !== 'end'
      ? operation.position.after
      : undefined
  const index = anchor
    ? current.paragraphs.findIndex((paragraph) => paragraph.paraId === anchor) + 1
    : before.paragraphCount
  const paragraph = current.paragraphs[index]
  const previousIds = new Set(before.paragraphs.map((entry) => entry.paraId))
  return paragraph?.text === operation.text && !previousIds.has(paragraph.paraId)
    ? paragraph
    : undefined
}

export function wrapOfficeDocxSnapshot(docx: OfficeDocxSnapshot): OfficeWriteSnapshot {
  return wrapSnapshot(docx)
}

function wrapSnapshot(docx: OfficeDocxSnapshot): OfficeWriteSnapshot {
  return Object.freeze({ cells: Object.freeze([]), rowCount: 0, columnCount: 0, docx })
}

function snapshotWithEvidence(before: OfficeDocxBefore): OfficeWriteSnapshot {
  return Object.freeze({
    cells: Object.freeze([]),
    rowCount: 0,
    columnCount: 0,
    docxBefore: Object.freeze(before)
  })
}

function beforeFromEvidence(before: OfficeDocxBefore | undefined): OfficeDocxSnapshot {
  if (!before) throw invalidEvidence()
  if (before.type === 'add_paragraph') {
    return { paragraphs: Object.freeze([]), paragraphCount: before.paragraphCount }
  }
  return {
    paragraphs: Object.freeze([
      {
        paraId: before.paraId,
        index: 0,
        text: before.text,
        editable: true
      }
    ]),
    paragraphCount: 1
  }
}

function requireSnapshot(value: OfficeWriteSnapshot | undefined): OfficeDocxSnapshot {
  if (!value?.docx) throw new OfficeWriteError('write_failed', '缺少 Word 段落快照')
  return value.docx
}

function requireParagraph(
  snapshot: OfficeDocxSnapshot,
  paraId: string
): OfficeDocxParagraphSnapshot {
  const paragraph = requireParagraphOrUndefined(snapshot, paraId)
  if (!paragraph) throw new OfficeWriteError('paragraph_not_found', '目标段落不存在')
  return paragraph
}

function requireParagraphOrUndefined(
  snapshot: OfficeDocxSnapshot,
  paraId: string
): OfficeDocxParagraphSnapshot | undefined {
  return snapshot.paragraphs.find((paragraph) => paragraph.paraId === paraId)
}

function paragraphPath(paraId: string): string {
  return `/body/p[@paraId=${paraId}]`
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 5_000
}

function invalidOperation(): OfficeWriteError {
  return new OfficeWriteError('invalid_value', 'Word 段落写入操作无效')
}

function invalidEvidence(): OfficeWriteError {
  return new OfficeWriteError('operation_log_corrupt', 'Word 写入前证据无效')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
