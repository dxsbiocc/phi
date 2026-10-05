import { visibleText } from './office-approval-summary'
import {
  assertOfficePptxTarget,
  captureOfficePptxBefore,
  normalizeOfficeElementId,
  normalizeOfficeSlideId,
  validateOfficePptxOperation,
  type OfficePptxBefore,
  type OfficePptxElementSnapshot,
  type OfficePptxOperation,
  type OfficePptxSnapshot
} from './office-pptx-contract'
import { officePptxLayoutWarning } from './office-pptx-element'
import { officePptxStableElementPath } from './office-pptx-identity'
import {
  normalizeOfficeWriteRevision,
  OfficeWriteError,
  type OfficeAddSlideDescription,
  type OfficeAddSlideResult,
  type OfficePptxWriteDescription,
  type OfficePptxWriteResult,
  type OfficeSetSlideTextDescription,
  type OfficeSetSlideTextResult,
  type OfficeWriteBefore,
  type OfficeWriteRequest,
  type OfficeWriteSnapshot
} from './office-write-contract'
import type { OfficeWriteOperationStrategy } from './office-write-operation-types'

export const addSlideStrategy = strategyFor('add_slide')
export const setSlideTextStrategy = strategyFor('set_slide_text')

type OfficePptxOperationCore = Pick<
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
>

function strategyFor(type: OfficePptxOperation['type']): OfficeWriteOperationStrategy {
  return {
    type,
    documentKind: 'pptx',
    ...operationCore(type),
    ...operationPresentation()
  }
}

function operationCore(type: OfficePptxOperation['type']): OfficePptxOperationCore {
  return {
    validate(operation, baseRevision) {
      const normalized = validateOfficePptxOperation(operation)
      if (normalized.type !== type) throw invalidOperation()
      return Object.freeze({
        operation: normalized,
        baseRevision: normalizeOfficeWriteRevision(baseRevision)
      })
    },
    digestInput: (request) => ({
      operation: request.operation,
      baseRevision: request.baseRevision
    }),
    affectedCells: () => [],
    readRange: () => '',
    expected: (_operation, before) =>
      before ?? snapshotWithEvidence({ type: 'add_slide', slideCount: 0 }),
    commands: () => {
      throw new OfficeWriteError(
        'operation_not_supported_for_kind',
        'PowerPoint 操作不能通过表格批处理执行'
      )
    },
    previewCondition(operation) {
      const value = operation as OfficePptxOperation
      return { kind: 'document', text: value.type === 'add_slide' ? value.title : value.text }
    },
    assertBefore(operation, before) {
      assertOfficePptxTarget(operation as OfficePptxOperation, requireSnapshot(before))
    },
    snapshot: () => {
      throw new OfficeWriteError('write_failed', 'PowerPoint 不能从单元格快照构造')
    },
    verify(operation, before, current) {
      return classify(operation as OfficePptxOperation, before, current) !== 'indeterminate'
    }
  }
}

function operationPresentation(): Pick<
  OfficeWriteOperationStrategy,
  'before' | 'restoreBefore' | 'describe' | 'approvalSummary' | 'result' | 'classify'
> {
  return {
    before(operation, snapshot) {
      return captureOfficePptxBefore(operation as OfficePptxOperation, requireSnapshot(snapshot))
    },
    restoreBefore(operation, before) {
      return restoreBefore(operation as OfficePptxOperation, before)
    },
    describe(request, before, documentName, revision) {
      return describe(request, requireSnapshot(before), documentName, revision)
    },
    approvalSummary(description) {
      return approvalSummary(description as OfficePptxWriteDescription)
    },
    result(request, before, revision, saved, previewConfirmed, current) {
      return result(request, before, requireSnapshot(current), revision, saved, previewConfirmed)
    },
    classify(operation, before, current) {
      return classify(operation as OfficePptxOperation, before, current)
    }
  }
}

function describe(
  request: OfficeWriteRequest,
  before: OfficePptxSnapshot,
  documentName: string,
  revision: number
): OfficePptxWriteDescription {
  const operation = request.operation as OfficePptxOperation
  if (operation.type === 'add_slide') {
    const anchor =
      operation.position && operation.position !== 'end' ? operation.position.after : undefined
    const index = anchor
      ? before.slides.findIndex((slide) => slide.slideId === anchor) + 1
      : before.slideCount
    return Object.freeze({
      type: operation.type,
      documentName,
      title: operation.title,
      ...(operation.body === undefined ? {} : { body: operation.body }),
      position: anchor ? { after: anchor, index } : 'end',
      revision
    }) satisfies OfficeAddSlideDescription
  }
  const target = requireElement(before, operation.slideId, operation.elementId)
  const slide = before.slides.find((entry) => entry.slideId === operation.slideId)!
  return Object.freeze({
    type: operation.type,
    documentName,
    slideId: operation.slideId,
    elementId: operation.elementId,
    index: slide.index,
    kind: target.kind,
    before: target.text,
    after: operation.text,
    revision
  }) satisfies OfficeSetSlideTextDescription
}

function approvalSummary(description: OfficePptxWriteDescription): string {
  if (description.type === 'add_slide') {
    const target =
      description.position === 'end'
        ? '演示文稿末尾'
        : `第 ${description.position.index} 页之后（${description.position.after}）`
    const body =
      description.body === undefined ? '' : `；正文：「${visibleText(description.body)}」`
    return `新增幻灯片到${target}；标题：「${visibleText(description.title)}」${body}（文档：${visibleText(description.documentName)}）`
  }
  return `修改第 ${description.index + 1} 页${elementKindLabel(description.kind)}（${description.slideId}/${description.elementId}）：「${visibleText(description.before)}」→「${visibleText(description.after)}」（文档：${visibleText(description.documentName)}）`
}

function result(
  request: OfficeWriteRequest,
  before: OfficeWriteSnapshot,
  current: OfficePptxSnapshot,
  revision: number,
  saved: boolean,
  previewConfirmed: boolean
): OfficePptxWriteResult {
  const operation = request.operation as OfficePptxOperation
  return operation.type === 'add_slide'
    ? addSlideResult(operation, before, current, revision, saved, previewConfirmed)
    : setSlideTextResult(operation, before, current, revision, saved, previewConfirmed)
}

function addSlideResult(
  operation: Extract<OfficePptxOperation, { type: 'add_slide' }>,
  before: OfficeWriteSnapshot,
  current: OfficePptxSnapshot,
  revision: number,
  saved: boolean,
  previewConfirmed: boolean
): OfficeAddSlideResult {
  const old = before.pptx
  const evidence = before.pptxBefore
  const warnings = previewConfirmed ? [] : ['preview_not_confirmed']
  const slide = addedSlide(operation, old, evidence, current)
  const title = requireKindElement(slide.elements, 'title')
  const body = slide.elements.find((element) => element.kind === 'body')
  const layoutWarning = [title, body].some(
    (element) => element && officePptxLayoutWarning(element.text, element.kind, element.geometry)
  )
    ? ('text_may_overflow' as const)
    : undefined
  return Object.freeze({
    applied: true,
    saved,
    revision,
    slideId: slide.slideId,
    path: `/slide[@id=${slide.slideId}]`,
    index: slide.index,
    title: title.text,
    ...(operation.body === undefined ? {} : { body: body?.text ?? '' }),
    previewConfirmed,
    ...resultWarnings(warnings, layoutWarning)
  })
}

function setSlideTextResult(
  operation: Extract<OfficePptxOperation, { type: 'set_slide_text' }>,
  before: OfficeWriteSnapshot,
  current: OfficePptxSnapshot,
  revision: number,
  saved: boolean,
  previewConfirmed: boolean
): OfficeSetSlideTextResult {
  const warnings = previewConfirmed ? [] : ['preview_not_confirmed']
  const previous = requireElement(
    before.pptx ?? beforeFromEvidence(before.pptxBefore),
    operation.slideId,
    operation.elementId
  )
  const slide = current.slides.find((entry) => entry.slideId === operation.slideId)!
  const element = requireElement(current, operation.slideId, operation.elementId)
  const layoutWarning = officePptxLayoutWarning(element.text, element.kind, element.geometry)
  return Object.freeze({
    applied: true,
    saved,
    revision,
    slideId: slide.slideId,
    elementId: element.elementId,
    path: officePptxStableElementPath(slide.slideId, element.elementId),
    index: slide.index,
    kind: element.kind,
    before: previous.text,
    after: element.text,
    previewConfirmed,
    ...resultWarnings(warnings, layoutWarning)
  })
}

function resultWarnings(
  warnings: readonly string[],
  layoutWarning?: 'text_may_overflow'
): Partial<Pick<OfficeSetSlideTextResult, 'layoutWarning' | 'warnings'>> {
  if (layoutWarning) return { layoutWarning, warnings: Object.freeze([...warnings, layoutWarning]) }
  return warnings.length ? { warnings: Object.freeze([...warnings]) } : {}
}

function classify(
  operation: OfficePptxOperation,
  before: OfficeWriteSnapshot,
  current: OfficeWriteSnapshot
): 'applied' | 'not_applied' | 'indeterminate' | 'applied_no_change' {
  const next = current.pptx
  if (!next) return 'indeterminate'
  if (operation.type === 'add_slide') {
    const evidence = before.pptxBefore?.type === 'add_slide' ? before.pptxBefore : undefined
    const count = before.pptx?.slideCount ?? evidence?.slideCount ?? -1
    if (next.slideCount === count) return 'not_applied'
    if (next.slideCount !== count + 1) return 'indeterminate'
    return addedSlideOrUndefined(operation, before.pptx, before.pptxBefore, next)
      ? 'applied'
      : 'indeterminate'
  }
  const old = before.pptx ?? beforeFromEvidence(before.pptxBefore)
  const previous = findElement(old, operation.slideId, operation.elementId)
  const element = findElement(next, operation.slideId, operation.elementId)
  if (!previous || !element) return 'indeterminate'
  if (element.text === operation.text)
    return previous.text === operation.text ? 'applied_no_change' : 'applied'
  return element.text === previous.text ? 'not_applied' : 'indeterminate'
}

function restoreBefore(
  operation: OfficePptxOperation,
  value: OfficeWriteBefore
): OfficeWriteSnapshot {
  if (!isRecord(value)) throw invalidEvidence()
  const stored = value as Record<string, unknown>
  if (stored.type !== operation.type) throw invalidEvidence()
  if (operation.type === 'add_slide') {
    if (!validCount(stored.slideCount)) throw invalidEvidence()
    const before: OfficePptxBefore = {
      type: operation.type,
      slideCount: stored.slideCount,
      ...(typeof stored.anchorSlideId === 'string'
        ? { anchorSlideId: normalizeOfficeSlideId(stored.anchorSlideId) }
        : {}),
      ...(typeof stored.previousSlideId === 'string'
        ? { previousSlideId: normalizeOfficeSlideId(stored.previousSlideId) }
        : {})
    }
    return snapshotWithEvidence(before)
  }
  if (
    typeof stored.text !== 'string' ||
    normalizeOfficeSlideId(stored.slideId) !== operation.slideId ||
    normalizeOfficeElementId(stored.elementId) !== operation.elementId
  )
    throw invalidEvidence()
  return snapshotWithEvidence({
    type: operation.type,
    slideId: operation.slideId,
    elementId: operation.elementId,
    text: stored.text
  })
}

function addedSlide(
  operation: Extract<OfficePptxOperation, { type: 'add_slide' }>,
  before: OfficePptxSnapshot | undefined,
  evidence: OfficePptxBefore | undefined,
  current: OfficePptxSnapshot
): OfficePptxSnapshot['slides'][number] {
  const slide = addedSlideOrUndefined(operation, before, evidence, current)
  if (!slide) throw new OfficeWriteError('write_verification_failed', '新增幻灯片读回不一致')
  return slide
}

function addedSlideOrUndefined(
  operation: Extract<OfficePptxOperation, { type: 'add_slide' }>,
  before: OfficePptxSnapshot | undefined,
  evidence: OfficePptxBefore | undefined,
  current: OfficePptxSnapshot
): OfficePptxSnapshot['slides'][number] | undefined {
  const addBefore = evidence?.type === 'add_slide' ? evidence : undefined
  const anchor =
    operation.position && operation.position !== 'end' ? operation.position.after : undefined
  const previous = anchor ?? before?.slides.at(-1)?.slideId ?? addBefore?.previousSlideId
  const previousIndex = previous
    ? current.slides.findIndex((slide) => slide.slideId === previous)
    : -1
  if (previous && previousIndex < 0) return undefined
  const index = previous ? previousIndex + 1 : 0
  const slide = current.slides[index]
  const oldIds = before ? new Set(before.slides.map((entry) => entry.slideId)) : undefined
  const title = slide?.elements.find((element) => element.kind === 'title')?.text
  const body = slide?.elements.find((element) => element.kind === 'body')?.text
  if (
    !slide ||
    title !== operation.title ||
    (operation.body !== undefined && body !== operation.body)
  )
    return undefined
  return oldIds?.has(slide.slideId) ? undefined : slide
}

export function wrapOfficePptxSnapshot(pptx: OfficePptxSnapshot): OfficeWriteSnapshot {
  return Object.freeze({ cells: Object.freeze([]), rowCount: 0, columnCount: 0, pptx })
}

function snapshotWithEvidence(before: OfficePptxBefore): OfficeWriteSnapshot {
  return Object.freeze({
    cells: Object.freeze([]),
    rowCount: 0,
    columnCount: 0,
    pptxBefore: Object.freeze(before)
  })
}

function beforeFromEvidence(before: OfficePptxBefore | undefined): OfficePptxSnapshot {
  if (!before || before.type !== 'set_slide_text') throw invalidEvidence()
  const element: OfficePptxElementSnapshot = {
    elementId: before.elementId,
    path: officePptxStableElementPath(before.slideId, before.elementId),
    cliPath: '',
    kind: 'text',
    text: before.text,
    editable: true
  }
  return { slides: [{ slideId: before.slideId, index: 0, elements: [element] }], slideCount: 1 }
}

function requireSnapshot(value: OfficeWriteSnapshot | undefined): OfficePptxSnapshot {
  if (!value?.pptx) throw new OfficeWriteError('write_failed', '缺少 PowerPoint 文本快照')
  return value.pptx
}

function requireElement(
  snapshot: OfficePptxSnapshot,
  slideId: string,
  elementId: string
): OfficePptxElementSnapshot {
  const element = findElement(snapshot, slideId, elementId)
  if (!element) throw new OfficeWriteError('element_not_found', '目标文本元素不存在')
  return element
}

function findElement(
  snapshot: OfficePptxSnapshot,
  slideId: string,
  elementId: string
): OfficePptxElementSnapshot | undefined {
  return snapshot.slides
    .find((slide) => slide.slideId === slideId)
    ?.elements.find((element) => element.elementId === elementId)
}

function requireKindElement(
  elements: readonly OfficePptxElementSnapshot[],
  kind: 'title'
): OfficePptxElementSnapshot {
  const element = elements.find((entry) => entry.kind === kind)
  if (!element) throw new OfficeWriteError('write_verification_failed', '新增幻灯片标题读回不一致')
  return element
}

function elementKindLabel(kind: 'title' | 'body' | 'text'): string {
  if (kind === 'title') return '标题'
  if (kind === 'body') return '正文'
  return '文本元素'
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 200
}

function invalidOperation(): OfficeWriteError {
  return new OfficeWriteError('invalid_value', 'PowerPoint 写入操作无效')
}

function invalidEvidence(): OfficeWriteError {
  return new OfficeWriteError('operation_log_corrupt', 'PowerPoint 写入前证据无效')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
