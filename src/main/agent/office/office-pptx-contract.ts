import { OFFICE_PRESENTATION_LIMITS } from './office-limits'
import type { OfficePptxElementGeometry, OfficePptxElementKind } from './office-pptx-element'
import { OfficeWriteError } from './office-write-contract'

export interface OfficeAddSlideOperation {
  readonly type: 'add_slide'
  readonly title: string
  readonly body?: string
  readonly position?: 'end' | Readonly<{ after: string }>
}

export interface OfficeSetSlideTextOperation {
  readonly type: 'set_slide_text'
  readonly slideId: string
  readonly elementId: string
  readonly text: string
  readonly expectedText?: string
}

export type OfficePptxOperation = OfficeAddSlideOperation | OfficeSetSlideTextOperation

export interface OfficePptxElementSnapshot {
  readonly elementId: string
  readonly path: string
  readonly cliPath: string
  readonly kind: OfficePptxElementKind
  readonly text: string
  readonly editable: boolean
  readonly geometry?: OfficePptxElementGeometry
}

export interface OfficePptxSlideSnapshot {
  readonly slideId: string
  readonly index: number
  readonly title?: string
  readonly elements: readonly OfficePptxElementSnapshot[]
}

export interface OfficePptxSnapshot {
  readonly slides: readonly OfficePptxSlideSnapshot[]
  readonly slideCount: number
}

export type OfficePptxBefore =
  | {
      readonly type: 'add_slide'
      readonly slideCount: number
      readonly anchorSlideId?: string
      readonly previousSlideId?: string
    }
  | {
      readonly type: 'set_slide_text'
      readonly slideId: string
      readonly elementId: string
      readonly text: string
    }

export type OfficePptxWriteReceipt =
  | {
      readonly type: 'add_slide'
      readonly slideId: string
      readonly path: string
      readonly index: number
    }
  | {
      readonly type: 'set_slide_text'
      readonly slideId: string
      readonly elementId: string
      readonly path: string
    }

export function validateOfficePptxOperation(value: unknown): OfficePptxOperation {
  if (!isRecord(value) || typeof value.type !== 'string') throw invalidOperation()
  if (value.type === 'add_slide') return validateAddSlide(value)
  if (value.type === 'set_slide_text') return validateSetSlideText(value)
  throw invalidOperation()
}

export function assertOfficePptxTarget(
  operation: OfficePptxOperation,
  snapshot: OfficePptxSnapshot
): void {
  if (operation.type === 'add_slide') {
    captureOfficePptxBefore(operation, snapshot)
    return
  }
  requireTargetElement(operation, snapshot)
}

export function captureOfficePptxBefore(
  operation: OfficePptxOperation,
  snapshot: OfficePptxSnapshot
): OfficePptxBefore {
  if (operation.type === 'set_slide_text') {
    const element = requireTargetElement(operation, snapshot)
    return {
      type: operation.type,
      slideId: operation.slideId,
      elementId: operation.elementId,
      text: element.text
    }
  }
  if (snapshot.slideCount >= OFFICE_PRESENTATION_LIMITS.maxSlides) {
    throw new OfficeWriteError('too_many_slides', 'PowerPoint 演示文稿已达到 200 张上限')
  }
  const anchorSlideId =
    operation.position !== undefined && operation.position !== 'end'
      ? operation.position.after
      : undefined
  if (anchorSlideId && !snapshot.slides.some((slide) => slide.slideId === anchorSlideId)) {
    throw slideNotFound()
  }
  const previousSlideId = anchorSlideId ?? snapshot.slides.at(-1)?.slideId
  return {
    type: operation.type,
    slideCount: snapshot.slideCount,
    ...(anchorSlideId ? { anchorSlideId } : {}),
    ...(previousSlideId ? { previousSlideId } : {})
  }
}

export function normalizeOfficeSlideId(value: unknown): string {
  return normalizeNumericId(value, '幻灯片定位编号无效', 256)
}

export function normalizeOfficeElementId(value: unknown): string {
  return normalizeNumericId(value, '文本元素定位编号无效', 1)
}

function validateAddSlide(value: Record<string, unknown>): OfficeAddSlideOperation {
  assertOnlyKeys(value, ['type', 'title', 'body', 'position'])
  const title = validateText(value.title, OFFICE_PRESENTATION_LIMITS.maxTitleTextLength, false)
  const body =
    value.body === undefined
      ? undefined
      : validateText(value.body, OFFICE_PRESENTATION_LIMITS.maxBodyTextLength, true)
  const position = validatePosition(value.position)
  return Object.freeze({
    type: 'add_slide',
    title,
    ...(body === undefined ? {} : { body }),
    ...(position === undefined ? {} : { position })
  })
}

function validateSetSlideText(value: Record<string, unknown>): OfficeSetSlideTextOperation {
  assertOnlyKeys(value, ['type', 'slideId', 'elementId', 'text', 'expectedText'])
  const expectedText =
    value.expectedText === undefined
      ? undefined
      : validateText(value.expectedText, OFFICE_PRESENTATION_LIMITS.maxBodyTextLength, true)
  return Object.freeze({
    type: 'set_slide_text',
    slideId: normalizeOfficeSlideId(value.slideId),
    elementId: normalizeOfficeElementId(value.elementId),
    text: validateText(value.text, OFFICE_PRESENTATION_LIMITS.maxBodyTextLength, false),
    ...(expectedText === undefined ? {} : { expectedText })
  })
}

function validatePosition(value: unknown): OfficeAddSlideOperation['position'] {
  if (value === undefined || value === 'end') return value
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'after')) {
    throw invalidOperation()
  }
  return Object.freeze({ after: normalizeOfficeSlideId(value.after) })
}

function requireTargetElement(
  operation: OfficeSetSlideTextOperation,
  snapshot: OfficePptxSnapshot
): OfficePptxElementSnapshot {
  const slide = snapshot.slides.find((entry) => entry.slideId === operation.slideId)
  if (!slide) throw slideNotFound()
  const element = slide.elements.find((entry) => entry.elementId === operation.elementId)
  if (!element)
    throw new OfficeWriteError('element_not_found', '目标文本元素不存在，请重新读取演示文稿')
  if (!element.editable) {
    throw new OfficeWriteError(
      'element_not_plain',
      '目标文本元素包含多个文本片段或复杂结构，不能安全修改'
    )
  }
  if (
    element.kind === 'title' &&
    operation.text.length > OFFICE_PRESENTATION_LIMITS.maxTitleTextLength
  ) {
    throw new OfficeWriteError('invalid_value', '标题文本超过 200 字符上限')
  }
  if (operation.expectedText !== undefined && operation.expectedText !== element.text) {
    throw new OfficeWriteError('stale_target', '目标文本已变化，请重新读取后再修改')
  }
  return element
}

function validateText(value: unknown, maxLength: number, allowEmpty: boolean): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxLength ||
    hasUnsupportedText(value)
  ) {
    throw new OfficeWriteError('invalid_value', 'PowerPoint 文本长度无效或包含不支持的控制字符')
  }
  return value
}

function hasUnsupportedText(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return (
      code === 10 ||
      code === 13 ||
      (code < 32 && code !== 9) ||
      code === 127 ||
      (code >= 0x80 && code <= 0x9f)
    )
  })
}

function normalizeNumericId(value: unknown, message: string, minimum: number): string {
  if (typeof value !== 'string' || !/^\d{1,10}$/u.test(value)) {
    throw new OfficeWriteError('invalid_value', message)
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > 0xffffffff) {
    throw new OfficeWriteError('invalid_value', message)
  }
  return String(number)
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalidOperation()
}

function invalidOperation(): OfficeWriteError {
  return new OfficeWriteError('invalid_value', 'PowerPoint 写入操作无效')
}

function slideNotFound(): OfficeWriteError {
  return new OfficeWriteError('slide_not_found', '目标幻灯片不存在，请重新读取演示文稿')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
