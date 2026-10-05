import type {
  OfficeAddSlideResult,
  OfficePptxWriteResult,
  OfficeSetSlideTextResult
} from './office-write-contract'

export function decodeOfficePptxResult(value: unknown): OfficePptxWriteResult {
  if (!isRecord(value) || !commonResult(value)) throw new Error('invalid PowerPoint write result')
  return Object.hasOwn(value, 'elementId') ? decodeSet(value) : decodeAdd(value)
}

function decodeAdd(value: Record<string, unknown>): OfficeAddSlideResult {
  if (
    !hasOnlyKeys(value, [...COMMON_KEYS, 'title', 'body']) ||
    typeof value.title !== 'string' ||
    (value.body !== undefined && typeof value.body !== 'string')
  )
    throw new Error('invalid add slide result')
  return {
    ...commonFields(value),
    title: value.title,
    ...(typeof value.body === 'string' ? { body: value.body } : {})
  }
}

function decodeSet(value: Record<string, unknown>): OfficeSetSlideTextResult {
  if (
    !hasOnlyKeys(value, [...COMMON_KEYS, 'elementId', 'kind', 'before', 'after']) ||
    !validId(value.elementId, 1) ||
    !['title', 'body', 'text'].includes(String(value.kind)) ||
    typeof value.before !== 'string' ||
    typeof value.after !== 'string'
  )
    throw new Error('invalid set slide text result')
  return {
    ...commonFields(value),
    elementId: value.elementId,
    kind: value.kind as 'title' | 'body' | 'text',
    before: value.before,
    after: value.after
  }
}

const COMMON_KEYS = [
  'applied',
  'saved',
  'revision',
  'slideId',
  'path',
  'index',
  'previewConfirmed',
  'layoutWarning',
  'warnings',
  'deduplicated',
  'reconciled'
] as const

function commonFields(
  value: Record<string, unknown>
): Omit<OfficeAddSlideResult, 'title' | 'body'> {
  return {
    applied: true,
    saved: value.saved === true,
    revision: value.revision as number,
    slideId: value.slideId as string,
    path: value.path as string,
    index: value.index as number,
    previewConfirmed: value.previewConfirmed === true,
    ...(value.layoutWarning === 'text_may_overflow' ? { layoutWarning: value.layoutWarning } : {}),
    ...(Array.isArray(value.warnings) ? { warnings: value.warnings as string[] } : {}),
    ...(value.deduplicated === true ? { deduplicated: true } : {}),
    ...(value.reconciled === true ? { reconciled: true } : {})
  }
}

function commonResult(value: Record<string, unknown>): boolean {
  const pathIsValid =
    value.path === `/slide[@id=${value.slideId}]` ||
    (typeof value.elementId === 'string' &&
      value.path === `/slide[@id=${value.slideId}]/shape[@id=${value.elementId}]`)
  return Boolean(
    value.applied === true &&
    typeof value.saved === 'boolean' &&
    validIndex(value.revision) &&
    validId(value.slideId, 256) &&
    pathIsValid &&
    validIndex(value.index) &&
    typeof value.previewConfirmed === 'boolean' &&
    (value.layoutWarning === undefined || value.layoutWarning === 'text_may_overflow') &&
    (value.warnings === undefined ||
      (Array.isArray(value.warnings) &&
        value.warnings.every((entry) => typeof entry === 'string'))) &&
    (value.deduplicated === undefined || value.deduplicated === true) &&
    (value.reconciled === undefined || value.reconciled === true)
  )
}

function validId(value: unknown, minimum: number): value is string {
  if (typeof value !== 'string' || !/^\d{1,10}$/u.test(value)) return false
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= 0xffffffff
}

function validIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
