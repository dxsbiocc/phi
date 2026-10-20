import { redactSensitiveText } from '../redaction'
import { errorMessage } from '../../../shared/errorCodes'

export type TransferErrorCode =
  | 'ABORTED'
  | 'DESTINATION_EXISTS'
  | 'HASH_MISMATCH'
  | 'HASH_UNAVAILABLE'
  | 'INSUFFICIENT_SPACE'
  | 'INVALID_MANIFEST'
  | 'INVALID_PARTIAL'
  | 'INVALID_REQUEST'
  | 'SOURCE_CHANGED'
  | 'TRANSFER_FAILED'

export const MAX_TRANSFER_ERROR_BYTES = 1024

const NETWORK_LOCATION = /\b(?:https?|ssh|sftp):\/\/[^\s"'<>]+/gi
const SCP_LOCATION = /\b[^@\s"']+@[^:\s"']+:[^\s"']+/g
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:\\(?:[^\\\s"']+\\)*[^\\\s"']*/g
const POSIX_ABSOLUTE_PATH = /(^|[\s("'=])\/(?:[^/\s"'`,;:)]+\/)*[^/\s"'`,;:)]+/g

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value)
  const limit = Math.max(0, Math.floor(maxBytes))
  if (encoded.byteLength <= limit) return value
  if (limit <= 3) return '.'.repeat(limit)

  let end = limit - 3
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1
  return `${encoded.subarray(0, end).toString('utf8')}...`
}

export function safeTransferText(value: unknown, maxBytes = MAX_TRANSFER_ERROR_BYTES): string {
  const text = errorMessage(value)
  const redacted = redactSensitiveText(text)
    .replace(NETWORK_LOCATION, '[redacted-location]')
    .replace(SCP_LOCATION, '[redacted-location]')
    .replace(WINDOWS_ABSOLUTE_PATH, '[redacted-path]')
    .replace(POSIX_ABSOLUTE_PATH, '$1[redacted-path]')
  return truncateUtf8(redacted, maxBytes)
}

export class TransferError extends Error {
  constructor(
    readonly code: TransferErrorCode,
    message: string
  ) {
    super(safeTransferText(message))
    this.name = 'TransferError'
  }
}

export function asTransferError(error: unknown): TransferError {
  if (error instanceof TransferError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new TransferError('ABORTED', 'Transfer cancelled')
  }
  return new TransferError('TRANSFER_FAILED', safeTransferText(error))
}
