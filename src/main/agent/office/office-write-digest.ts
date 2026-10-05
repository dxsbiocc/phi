import { createHash } from 'node:crypto'

import {
  formatRangeWriteRequest,
  rangeWriteRequest,
  serializeOfficeWriteRequest,
  validateStoredOfficeWriteRequest
} from './office-write-operation'
import { validateRangeEditParams } from './office-write-contract'
import type { OfficeWriteRequest } from './office-write-contract'

export function officeWriteDigest(input: unknown): string {
  const request: OfficeWriteRequest = normalizedDigestRequest(input)
  return createHash('sha256').update(serializeOfficeWriteRequest(request)).digest('hex')
}

function normalizedDigestRequest(input: unknown): OfficeWriteRequest {
  if (isRecord(input) && isRecord(input.operation) && input.operation.type === 'format_range') {
    return formatRangeWriteRequest({
      sheet: input.operation.sheet,
      range: input.operation.range,
      format: input.operation.format,
      baseRevision: input.baseRevision
    })
  }
  if (isRecord(input) && isRecord(input.operation) && input.operation.type === 'set_range') {
    const operation = input.operation
    if (
      Object.hasOwn(operation, 'rowCount') ||
      Object.hasOwn(operation, 'columnCount') ||
      Object.hasOwn(operation, 'cellCount')
    ) {
      return rangeWriteRequest(
        validateRangeEditParams({
          sheet: operation.sheet,
          range: operation.range,
          values: operation.values,
          baseRevision: input.baseRevision
        })
      )
    }
  }
  return validateStoredOfficeWriteRequest(input)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
