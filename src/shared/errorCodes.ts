/**
 * Structured error codes for the remote/engine paths. State machines branch on
 * `code`, never on message text; `message` is for display only. Code that has
 * not been migrated yet is `UNKNOWN`.
 */

export const ERROR_CODES = {
  /** The transport is confirmed dead: the project goes offline and hosts are released. */
  TRANSPORT_LOST: { retryable: true },
  /** One call timed out and its outcome is unknown; the connection is untouched. */
  TIMEOUT_UNKNOWN: { retryable: false },
  /** The model provider failed; retryable depends on the provider's own signal. */
  PROVIDER_ERROR: { retryable: false },
  /** The user denied an approval. Not counted as a failure. */
  APPROVAL_DENIED: { retryable: false },
  /** The user or the app aborted the work. Not counted as a failure. */
  ABORTED: { retryable: false },
  /** Domain errors are shown to the user and never touch the connection. */
  DOMAIN_NOT_FOUND: { retryable: false },
  DOMAIN_INVALID: { retryable: false },
  DOMAIN_CONFLICT: { retryable: false },
  /** Not migrated to structured codes yet. */
  UNKNOWN: { retryable: false }
} as const satisfies Record<string, { retryable: boolean }>

export type ErrorCode = keyof typeof ERROR_CODES

/** The serializable shape that crosses IPC. */
export interface ErrorPayload {
  code: ErrorCode
  retryable: boolean
  message: string
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value)
}

export class CodedError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CodedError'
    this.code = code
    this.retryable = options.retryable ?? ERROR_CODES[code].retryable
  }
}

export function errorCodeOf(error: unknown): ErrorCode {
  if (typeof error !== 'object' || error === null) return 'UNKNOWN'
  const code = (error as { code?: unknown }).code
  return isErrorCode(code) ? code : 'UNKNOWN'
}

export function isRetryable(error: unknown): boolean {
  const explicit =
    typeof error === 'object' && error !== null
      ? (error as { retryable?: unknown }).retryable
      : undefined
  return typeof explicit === 'boolean' ? explicit : ERROR_CODES[errorCodeOf(error)].retryable
}

/** Display-only text for any thrown value. Never branch on this string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function toErrorPayload(error: unknown): ErrorPayload {
  return {
    code: errorCodeOf(error),
    retryable: isRetryable(error),
    message: errorMessage(error)
  }
}
