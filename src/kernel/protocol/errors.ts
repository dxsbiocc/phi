import {
  protocolErrorCodes,
  type JsonValue,
  type ProtocolError,
  type ProtocolErrorCode
} from '../../shared/kernel-protocol'

const protocolErrorCodeSet = new Set<string>(protocolErrorCodes)
const DESKTOP_CREDENTIAL_BROKER_REASON = 'desktop_credential_broker_not_connected'
const DESKTOP_CREDENTIAL_BROKER_MESSAGE = 'The desktop credential broker is not connected.'

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
  MODEL_UNAVAILABLE: 'The requested model is unavailable.',
  MODEL_UNREACHABLE: 'Model access is temporarily unreachable.',
  MODEL_UNAUTHENTICATED: 'The requested model provider is not authenticated.',
  MODEL_CONNECTION_LOST: 'The model connection was lost after the response started.',
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

export function sanitizedRunFailureDetail(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value)
  const sanitized = message
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s:]+[\\/])*[^\s:]*/g, '<path>')
    .trim()
  return (sanitized || 'Run failed before completion.').slice(0, 1024)
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
  const detail = error.detail
  const brokerDisconnected =
    error.code === 'MODEL_UNAUTHENTICATED' &&
    detail !== null &&
    typeof detail === 'object' &&
    !Array.isArray(detail) &&
    Object.keys(detail).length === 1 &&
    detail.reason === DESKTOP_CREDENTIAL_BROKER_REASON
  return {
    ...error,
    message: brokerDisconnected
      ? DESKTOP_CREDENTIAL_BROKER_MESSAGE
      : safeHandlerErrorMessages[error.code]
  }
}
