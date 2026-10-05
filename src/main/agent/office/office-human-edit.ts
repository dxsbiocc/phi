import { OFFICE_CONTENT_LIMITS } from './office-limits'
import { columnNumber, validOfficeSheetName } from './office-read-contract'

export const OFFICE_HUMAN_EDIT_LIMITS = Object.freeze({
  maxBodyBytes: 64 * 1024,
  maxTextCharacters: OFFICE_CONTENT_LIMITS.maxCellTextLength,
  maxRows: OFFICE_CONTENT_LIMITS.maxWorkbookRows,
  maxColumns: OFFICE_CONTENT_LIMITS.maxWorkbookColumns,
  maxEditsPerSecond: 5,
  maxPendingEdits: 20
})

const EDIT_RATE_WINDOW_MS = 1_000

export interface OfficeHumanCellEdit {
  readonly artifactId: string
  readonly operationId: string
  readonly sheet: string
  readonly cell: string
  readonly text: string
}

export type OfficeHumanEditAccess = 'writable' | 'read_only' | 'frozen'

export function humanEditErrorResponse(error: unknown): Readonly<{ status: number; code: string }> {
  const code = (error as { code?: unknown })?.code
  if (code === 'document_read_only' || code === 'document_frozen') return { status: 423, code }
  if (code === 'formula_invalid') return { status: 422, code }
  if (
    code === 'invalid_sheet' ||
    code === 'invalid_cell' ||
    code === 'invalid_value' ||
    code === 'range_out_of_bounds' ||
    code === 'formula_not_supported'
  ) {
    return { status: 400, code }
  }
  if (
    code === 'write_unknown' ||
    code === 'write_verification_failed' ||
    code === 'reconcile_indeterminate'
  ) {
    return { status: 423, code: 'document_frozen' }
  }
  if (code === 'target_not_found' || code === 'target_missing') {
    return { status: 410, code: 'edit_unavailable' }
  }
  return { status: 500, code: code === 'save_failed' ? code : 'edit_failed' }
}

export interface ParsedOfficeHumanCellEdit {
  readonly sheet: string
  readonly cell: string
  readonly text: string
}

export class OfficeHumanEditRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
    this.name = 'OfficeHumanEditRequestError'
  }
}

export class OfficeHumanEditGate {
  private readonly acceptedAt: number[] = []
  private pending = 0

  constructor(private readonly clock: () => number = Date.now) {}

  enter(): (() => void) | undefined {
    if (this.pending >= OFFICE_HUMAN_EDIT_LIMITS.maxPendingEdits) return undefined
    const now = this.clock()
    while (this.acceptedAt[0] !== undefined && this.acceptedAt[0] <= now - EDIT_RATE_WINDOW_MS) {
      this.acceptedAt.shift()
    }
    if (this.acceptedAt.length >= OFFICE_HUMAN_EDIT_LIMITS.maxEditsPerSecond) return undefined
    this.acceptedAt.push(now)
    this.pending += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.pending -= 1
    }
  }

  get atPendingLimit(): boolean {
    return this.pending >= OFFICE_HUMAN_EDIT_LIMITS.maxPendingEdits
  }
}

export function parseOfficeHumanCellEditBody(body: string): ParsedOfficeHumanCellEdit {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw invalidEditRequest()
  }
  if (!isRecord(value) || !hasExactKeys(value, ['path', 'prop', 'value'])) {
    throw invalidEditRequest()
  }
  if (value.prop !== 'text' || typeof value.path !== 'string' || typeof value.value !== 'string') {
    throw invalidEditRequest()
  }
  const target = parseCellPath(value.path)
  assertValidText(value.value)
  return Object.freeze({ ...target, text: value.value })
}

function parseCellPath(path: string): Readonly<{ sheet: string; cell: string }> {
  const match = /^\/([^/]+)\/([A-Z]{1,3}[1-9][0-9]{0,6})$/.exec(path)
  if (!match || !validOfficeSheetName(match[1])) throw invalidEditRequest()
  const columnMatch = /^([A-Z]+)([1-9][0-9]{0,6})$/.exec(match[2])
  if (
    !columnMatch ||
    columnNumber(columnMatch[1]) > OFFICE_HUMAN_EDIT_LIMITS.maxColumns ||
    Number(columnMatch[2]) > OFFICE_HUMAN_EDIT_LIMITS.maxRows
  ) {
    throw invalidEditRequest()
  }
  return Object.freeze({ sheet: match[1], cell: match[2] })
}

function assertValidText(text: string): void {
  if ([...text].length > OFFICE_HUMAN_EDIT_LIMITS.maxTextCharacters) {
    throw invalidEditRequest()
  }
  for (const character of text) {
    const code = character.charCodeAt(0)
    if (
      (code < 32 && code !== 9 && code !== 10) ||
      code === 127 ||
      (code >= 0x80 && code <= 0x9f)
    ) {
      throw invalidEditRequest()
    }
  }
}

function invalidEditRequest(): OfficeHumanEditRequestError {
  return new OfficeHumanEditRequestError(400, 'invalid_edit')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}
