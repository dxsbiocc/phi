import {
  OFFICE_READ_LIMITS,
  OfficeReadError,
  parseOfficeRange,
  validOfficeSheetName,
  type OfficeReadParams
} from './office-read'
import type { OfficeDocumentReadResponse } from './office-docx-read'
import {
  OfficeWriteError,
  validateCellEditParams,
  type OfficeCellEditDescription,
  type OfficeCellEditOptions,
  type OfficeCellEditParams,
  type OfficeCellEditResult,
  type OfficeDescribeCellEditParams,
  type OfficeWriteRequest,
  type OfficeWriteDescription,
  type OfficeWriteReceiptResult,
  type OfficeWriteResult
} from './office-write-contract'
import { sanitizeFormulaEditResult } from './office-formula-tool-sanitizer'
import { sanitizeDocxWriteResult } from './office-docx-tool-sanitizer'
import { sanitizePptxWriteResult } from './office-pptx-tool-sanitizer'
import { validateOfficeWriteRequest } from './office-write-operation'
import {
  OFFICE_NO_TARGET_MESSAGE,
  safeWriteMessage,
  sanitizeAddSheetResult,
  sanitizeCellEditDescription,
  sanitizeCellEditResult,
  sanitizeFailureResult,
  sanitizeFormatRangeResult,
  sanitizeRangeEditResult,
  sanitizeWriteDescription
} from './office-write-tool-sanitizer'

export interface OfficeReadHostContext {
  readonly originSessionId?: string
  readonly agentRunId?: string
  readonly toolCallId?: string
}

export interface OfficeReadHostDependencies {
  resolveActiveRun(originSessionId: string): { runId: string } | undefined
  readRange(runId: string, params: OfficeReadParams): Promise<OfficeDocumentReadResponse>
}

export type OfficeReadHostResult =
  | { readonly ok: true; readonly value: OfficeDocumentReadResponse }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

interface OfficeDescribeHostDependencies {
  resolveActiveRun(originSessionId: string): { runId: string } | undefined
  describeCellEdit(
    runId: string,
    params: OfficeDescribeCellEditParams
  ): Promise<OfficeCellEditDescription>
  describeWriteRequest?(runId: string, request: OfficeWriteRequest): Promise<OfficeWriteDescription>
}

type OfficeHostFailure = {
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
    readonly result?: OfficeWriteReceiptResult
    readonly deduplicated?: true
    readonly sheetNames?: readonly string[]
  }
}

type OfficeDescribeHostResult =
  { readonly ok: true; readonly value: OfficeWriteDescription } | OfficeHostFailure

interface OfficeApplyHostDependencies {
  resolveActiveRun(originSessionId: string): { runId: string } | undefined
  authorizeApply?(
    runId: string,
    toolCallId: string | undefined,
    params: OfficeCellEditParams
  ): boolean | Promise<boolean>
  applyCellEdit(
    runId: string,
    params: OfficeCellEditParams,
    options: OfficeCellEditOptions
  ): Promise<OfficeCellEditResult>
  authorizeWrite?(
    runId: string,
    toolCallId: string | undefined,
    request: OfficeWriteRequest
  ): boolean | Promise<boolean>
  applyWriteRequest?(
    runId: string,
    request: OfficeWriteRequest,
    options: OfficeCellEditOptions
  ): Promise<OfficeWriteResult>
}

type OfficeApplyHostResult =
  { readonly ok: true; readonly value: OfficeWriteResult } | OfficeHostFailure

export function createOfficeReadHostHandler(
  dependencies: OfficeReadHostDependencies
): (params: unknown, context: OfficeReadHostContext) => Promise<OfficeReadHostResult> {
  return async (params, context) => {
    const runId = context.agentRunId ?? activeRunId(dependencies, context.originSessionId)
    if (!runId) {
      return {
        ok: false,
        error: { code: 'no_target', message: OFFICE_NO_TARGET_MESSAGE }
      }
    }
    try {
      const value = await dependencies.readRange(runId, officeReadParams(params))
      return { ok: true, value }
    } catch (error) {
      return officeReadFailure(error)
    }
  }
}

export function createOfficeDescribeHostHandler(
  dependencies: OfficeDescribeHostDependencies
): (params: unknown, context: OfficeReadHostContext) => Promise<OfficeDescribeHostResult> {
  return async (params, context) => {
    const runId = context.agentRunId ?? activeRunId(dependencies, context.originSessionId)
    if (!runId) return noTargetResult()
    try {
      const request = parseOfficeWriteRequest(params)
      const value =
        request.operation.type !== 'set_cell'
          ? sanitizeWriteDescription(
              request,
              await requireDescribeWrite(dependencies)(runId, request)
            )
          : sanitizeCellEditDescription(
              await dependencies.describeCellEdit(runId, descriptionParams(cellParams(request)))
            )
      if (value.revision !== request.baseRevision) {
        throw new OfficeWriteError('revision_conflict', '文档已更新，请先重新读取后再修改')
      }
      return { ok: true, value }
    } catch (error) {
      return officeWriteFailure(error)
    }
  }
}

export function createOfficeApplyHostHandler(
  dependencies: OfficeApplyHostDependencies
): (params: unknown, context: OfficeReadHostContext) => Promise<OfficeApplyHostResult> {
  return async (params, context) => {
    const runId = context.agentRunId ?? activeRunId(dependencies, context.originSessionId)
    if (!runId) return noTargetResult()
    try {
      if (!context.toolCallId) {
        throw new OfficeWriteError('missing_operation_id', '写入请求缺少可信操作编号，未做任何修改')
      }
      const request = parseOfficeWriteRequest(params)
      if (request.operation.type !== 'set_cell') {
        return {
          ok: true,
          value: await applyStructuredWrite(dependencies, runId, context.toolCallId, request)
        }
      }
      const input = cellParams(request)
      const value = await dependencies.applyCellEdit(runId, input, {
        operationId: context.toolCallId,
        ...(dependencies.authorizeWrite || dependencies.authorizeApply
          ? {
              authorize: () =>
                dependencies.authorizeWrite
                  ? dependencies.authorizeWrite(runId, context.toolCallId, request)
                  : dependencies.authorizeApply!(runId, context.toolCallId, input)
            }
          : {})
      })
      return { ok: true, value: sanitizeCellEditResult(value) }
    } catch (error) {
      return officeWriteFailure(error)
    }
  }
}

async function applyStructuredWrite(
  dependencies: OfficeApplyHostDependencies,
  runId: string,
  toolCallId: string,
  request: OfficeWriteRequest
): Promise<OfficeWriteResult> {
  if (!dependencies.applyWriteRequest) {
    throw new OfficeWriteError('write_failed', 'Office 写入能力不可用')
  }
  const value = await dependencies.applyWriteRequest(runId, request, {
    operationId: toolCallId,
    ...(dependencies.authorizeWrite
      ? { authorize: () => dependencies.authorizeWrite!(runId, toolCallId, request) }
      : {})
  })
  return sanitizeStructuredWriteResult(request, value)
}

function sanitizeStructuredWriteResult(
  request: OfficeWriteRequest,
  value: OfficeWriteResult
): OfficeWriteResult {
  const type = request.operation.type
  if (type === 'add_slide' || type === 'set_slide_text') return sanitizePptxWriteResult(value)
  if (type === 'add_paragraph' || type === 'set_paragraph_text') {
    return sanitizeDocxWriteResult(value)
  }
  if (type === 'add_sheet') return sanitizeAddSheetResult(value)
  if (type === 'set_formula') return sanitizeFormulaEditResult(value)
  if (type === 'format_range') return sanitizeFormatRangeResult(value)
  return sanitizeRangeEditResult(value)
}

export function parseOfficeCellEditParams(value: unknown): OfficeCellEditParams {
  const request = parseOfficeWriteRequest(value)
  if (request.operation.type !== 'set_cell') {
    throw new OfficeWriteError('invalid_value', '写入操作必须是 set_cell')
  }
  return cellParams(request)
}

export function parseOfficeWriteRequest(value: unknown): OfficeWriteRequest {
  if (!isRecord(value) || !isRecord(value.operation)) {
    throw new OfficeWriteError('invalid_value', '写入操作无效')
  }
  // Model-supplied authority fields are discarded; every remaining public field is strict.
  const ignored = new Set(['runId', 'sessionId', 'artifactId', 'path', 'toolCallId'])
  const operation = Object.fromEntries(
    Object.entries(value.operation).filter(([key]) => !ignored.has(key))
  )
  const input = Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.has(key)))
  return validateOfficeWriteRequest({ ...input, operation })
}

function cellParams(request: OfficeWriteRequest): OfficeCellEditParams {
  if (request.operation.type !== 'set_cell') {
    throw new OfficeWriteError('invalid_value', '写入操作必须是 set_cell')
  }
  return validateCellEditParams({
    sheet: request.operation.sheet,
    cell: request.operation.cell,
    value: request.operation.value,
    baseRevision: request.baseRevision
  })
}

function descriptionParams(params: OfficeCellEditParams): OfficeDescribeCellEditParams {
  return { sheet: params.sheet, cell: params.cell, value: params.value }
}

function noTargetResult(): OfficeHostFailure {
  return { ok: false, error: { code: 'no_target', message: OFFICE_NO_TARGET_MESSAGE } }
}

function officeWriteFailure(error: unknown): OfficeHostFailure {
  if (error instanceof OfficeWriteError) {
    const result = sanitizeFailureResult(error)
    return {
      ok: false,
      error: {
        code: error.code,
        message: safeWriteMessage(error.code),
        ...(result ? { result } : {}),
        ...(error.code === 'sheet_exists' || error.code === 'too_many_sheets'
          ? { sheetNames: safeSheetNames(error.details?.sheetNames) }
          : {}),
        ...(error.details?.deduplicated === true ? { deduplicated: true as const } : {})
      }
    }
  }
  return {
    ok: false,
    error: { code: 'write_failed', message: '无法修改 Office 内容，请稍后重试' }
  }
}

function safeSheetNames(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((name) => typeof name === 'string' && validOfficeSheetName(name))
  ) {
    return []
  }
  return Object.freeze(value.slice(0, 20))
}

function requireDescribeWrite(
  dependencies: OfficeDescribeHostDependencies
): NonNullable<OfficeDescribeHostDependencies['describeWriteRequest']> {
  if (!dependencies.describeWriteRequest) {
    throw new OfficeWriteError('write_failed', 'Office 写入说明能力不可用')
  }
  return dependencies.describeWriteRequest
}

function officeReadFailure(error: unknown): Extract<OfficeReadHostResult, { ok: false }> {
  if (error instanceof OfficeReadError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.code === 'no_target' ? OFFICE_NO_TARGET_MESSAGE : error.message
      }
    }
  }
  return {
    ok: false,
    error: { code: 'read_failed', message: '无法读取 Office 内容，请稍后重试' }
  }
}

function activeRunId(
  dependencies: { resolveActiveRun(originSessionId: string): { runId: string } | undefined },
  originSessionId: string | undefined
): string | undefined {
  return originSessionId ? dependencies.resolveActiveRun(originSessionId)?.runId : undefined
}

function officeReadParams(value: unknown): OfficeReadParams {
  if (!isRecord(value)) throw new OfficeReadError('invalid_range', '读取参数必须是对象')
  validateSheet(value.sheet)
  validateRange(value.range)
  validateCursor(value.cursor)
  validateMaxCells(value.maxCells)
  validateParagraphOffset(value.from)
  validateParagraphLimit(value.limit)
  return {
    ...(typeof value.sheet === 'string' ? { sheet: value.sheet } : {}),
    ...(typeof value.range === 'string' ? { range: value.range } : {}),
    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
    ...(typeof value.maxCells === 'number' ? { maxCells: value.maxCells } : {}),
    ...(typeof value.from === 'number' ? { from: value.from } : {}),
    ...(typeof value.limit === 'number' ? { limit: value.limit } : {})
  } as OfficeReadParams
}

function validateSheet(value: unknown): void {
  if (value === undefined) return
  if (typeof value !== 'string' || !validOfficeSheetName(value)) {
    throw new OfficeReadError('invalid_sheet', '工作表名称无效')
  }
}

function validateRange(value: unknown): void {
  if (value === undefined) return
  if (typeof value !== 'string') {
    throw new OfficeReadError('invalid_range', '单元格范围必须是字符串')
  }
  parseOfficeRange(value)
}

function validateCursor(value: unknown): void {
  if (value === undefined) return
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new OfficeReadError('invalid_cursor', '继续读取标记无效')
  }
}

function validateMaxCells(value: unknown): void {
  if (value === undefined) return
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > OFFICE_READ_LIMITS.maxCells
  ) {
    throw new OfficeReadError(
      'invalid_range',
      `maxCells 必须是 1 到 ${OFFICE_READ_LIMITS.maxCells} 的整数`
    )
  }
}

function validateParagraphOffset(value: unknown): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new OfficeReadError('invalid_arguments', 'from 必须是非负整数')
  }
}

function validateParagraphLimit(value: unknown): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new OfficeReadError('invalid_arguments', 'limit 必须是 1 到 200 的整数')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
