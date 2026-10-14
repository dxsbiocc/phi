/** A local byte budget, not a server reason code or a generic protocol classification. */
export class RpcByteLimitError extends Error {
  constructor(
    message: string,
    readonly scope: 'command-frame' | 'physical-frame' | 'reassembled-frame',
    readonly limitBytes: number,
    readonly actualBytes: number,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'RpcByteLimitError'
  }
}

export const MAX_RPC_ERROR_CODE_BYTES = 256

/** The SDK declares code?: string; bound unknown future codes without interpreting them. */
export function validRpcErrorCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_RPC_ERROR_CODE_BYTES
  )
}

export class RpcRequestError extends Error {
  readonly requestId: string
  readonly command: string
  declare readonly code?: string

  constructor(
    response: { id: string; command: string; error: string; code?: string },
    options?: ErrorOptions
  ) {
    super(response.error, options)
    this.name = 'RpcRequestError'
    this.requestId = response.id
    this.command = response.command
    if (response.code !== undefined) {
      if (!validRpcErrorCode(response.code)) throw new Error('Invalid RPC response code')
      this.code = response.code
    }
  }
}
