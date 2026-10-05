import type {
  OfficeAddParagraphResult,
  OfficeDocxWriteResult,
  OfficeSetParagraphTextResult
} from './office-write-contract'

export function decodeOfficeDocxResult(value: unknown): OfficeDocxWriteResult {
  if (!isRecord(value) || !commonResult(value)) throw new Error('invalid Word write result')
  return Object.hasOwn(value, 'text') ? decodeAdd(value) : decodeSet(value)
}

function decodeAdd(value: Record<string, unknown>): OfficeAddParagraphResult {
  if (
    !hasOnlyKeys(value, [
      'applied',
      'saved',
      'revision',
      'paraId',
      'path',
      'index',
      'text',
      'previewConfirmed',
      'warnings',
      'deduplicated',
      'reconciled'
    ]) ||
    typeof value.text !== 'string'
  )
    throw new Error('invalid add paragraph result')
  return {
    ...commonFields(value),
    text: value.text
  }
}

function decodeSet(value: Record<string, unknown>): OfficeSetParagraphTextResult {
  if (
    !hasOnlyKeys(value, [
      'applied',
      'saved',
      'revision',
      'paraId',
      'path',
      'index',
      'before',
      'after',
      'previewConfirmed',
      'warnings',
      'deduplicated',
      'reconciled'
    ]) ||
    typeof value.before !== 'string' ||
    typeof value.after !== 'string'
  )
    throw new Error('invalid set paragraph result')
  return {
    ...commonFields(value),
    before: value.before,
    after: value.after
  }
}

function commonFields(value: Record<string, unknown>): Omit<OfficeAddParagraphResult, 'text'> {
  return {
    applied: true as const,
    saved: value.saved === true,
    revision: value.revision as number,
    paraId: value.paraId as string,
    path: value.path as string,
    index: value.index as number,
    previewConfirmed: value.previewConfirmed === true,
    ...(Array.isArray(value.warnings) ? { warnings: value.warnings as string[] } : {}),
    ...(value.deduplicated === true ? { deduplicated: true as const } : {}),
    ...(value.reconciled === true ? { reconciled: true as const } : {})
  }
}

function commonResult(value: Record<string, unknown>): boolean {
  return Boolean(
    value.applied === true &&
    typeof value.saved === 'boolean' &&
    validIndex(value.revision) &&
    typeof value.paraId === 'string' &&
    /^[0-9A-F]{8}$/u.test(value.paraId) &&
    value.path === `/body/p[@paraId=${value.paraId}]` &&
    validIndex(value.index) &&
    typeof value.previewConfirmed === 'boolean' &&
    (value.warnings === undefined ||
      (Array.isArray(value.warnings) &&
        value.warnings.every((entry) => typeof entry === 'string'))) &&
    (value.deduplicated === undefined || value.deduplicated === true) &&
    (value.reconciled === undefined || value.reconciled === true)
  )
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
