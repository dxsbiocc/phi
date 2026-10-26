import { z } from 'zod'

import { MAX_ERROR_DETAIL_BYTES } from './constants'
import { jsonValueSchema, type JsonValue } from './json'

export const protocolErrorCodes = [
  'VERSION_UNSUPPORTED',
  'NOT_NEGOTIATED',
  'STALE_GENERATION',
  'NOT_CONTROLLER',
  'UNKNOWN_METHOD',
  'INVALID_FRAME',
  'INVALID_PARAMS',
  'FRAME_TOO_LARGE',
  'DUPLICATE_REQUEST',
  'SESSION_NOT_FOUND',
  'SESSION_BUSY',
  'MODEL_UNAVAILABLE',
  'MODEL_UNREACHABLE',
  'MODEL_UNAUTHENTICATED',
  'MODEL_CONNECTION_LOST',
  'CAPABILITY_UNAVAILABLE',
  'REPLAY_GAP',
  'CANCELLED',
  'INTERNAL'
] as const

export const protocolErrorCodeSchema = z.enum(protocolErrorCodes)
export type ProtocolErrorCode = z.infer<typeof protocolErrorCodeSchema>

const textEncoder = new TextEncoder()

function detailFitsFrame(detail: JsonValue | undefined): boolean {
  if (detail === undefined) return true
  return textEncoder.encode(JSON.stringify(detail)).byteLength <= MAX_ERROR_DETAIL_BYTES
}

export const protocolErrorSchema = z
  .object({
    code: protocolErrorCodeSchema,
    message: z.string().min(1),
    detail: jsonValueSchema.optional()
  })
  .strict()
  .refine((error) => detailFitsFrame(error.detail), {
    message: `Error detail must not exceed ${MAX_ERROR_DETAIL_BYTES} UTF-8 bytes`,
    path: ['detail']
  })

export type ProtocolError = z.infer<typeof protocolErrorSchema>

export class ProtocolEncodeError extends Error {
  readonly code: Extract<ProtocolErrorCode, 'INVALID_FRAME' | 'FRAME_TOO_LARGE'>

  constructor(
    code: Extract<ProtocolErrorCode, 'INVALID_FRAME' | 'FRAME_TOO_LARGE'>,
    message: string
  ) {
    super(message)
    this.name = 'ProtocolEncodeError'
    this.code = code
  }
}
