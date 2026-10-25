import {
  protocolErrorCodes,
  type JsonValue,
  type ProtocolError,
  type ProtocolErrorCode
} from '../../shared/kernel-protocol'

const protocolErrorCodeSet = new Set<string>(protocolErrorCodes)

const safeHandlerErrorMessages: Record<ProtocolErrorCode, string> = {
  VERSION_UNSUPPORTED: 'The requested protocol version is unsupported.',
  NOT_NEGOTIATED: 'The connection has not completed protocol negotiation.',
  STALE_GENERATION: 'The request belongs to an inactive controller generation.',
  NOT_CONTROLLER: 'The connection is not the active controller.',
  UNKNOWN_METHOD: 'The requested kernel method is unknown.',
  INVALID_FRAME: 'The request frame is invalid.',
  INVALID_PARAMS: 'The request parameters are invalid.',
  FRAME_TOO_LARGE: 'The request frame is too large.',
  DUPLICATE_REQUEST: 'The request id was already used on this connection.',
  SESSION_NOT_FOUND: 'The requested session was not found.',
  SESSION_BUSY: 'The requested session already has an active run.',
  CAPABILITY_UNAVAILABLE: 'The requested capability is unavailable.',
  REPLAY_GAP: 'The requested event range is no longer available.',
  CANCELLED: 'The request was cancelled.',
  INTERNAL: 'The kernel method failed internally.'
}

export function makeProtocolError(
  code: ProtocolErrorCode,
  message: string,
  detail?: JsonValue
): ProtocolError {
  return detail === undefined ? { code, message } : { code, message, detail }
}

export function normalizeHandlerError(value: unknown): ProtocolError | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<ProtocolError>
  if (
    typeof candidate.code !== 'string' ||
    !protocolErrorCodeSet.has(candidate.code) ||
    typeof candidate.message !== 'string' ||
    candidate.message.length === 0
  ) {
    return undefined
  }
  const error = candidate as ProtocolError
  return { ...error, message: safeHandlerErrorMessages[error.code] }
}
