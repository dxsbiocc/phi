interface DbHttpErrorOptions {
  code: string
  retryable: boolean
  attempts: number
  redactedUrl: string
  transportName: string
  status?: number
  lastStatus?: number
  nextSuggestedWaitMs?: number
  cause?: unknown
}

export class DbHttpError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly attempts: number
  readonly status?: number
  readonly lastStatus?: number
  readonly nextSuggestedWaitMs?: number
  readonly safeDetails: {
    redactedUrl: string
    transportName: string
  }

  constructor(message: string, options: DbHttpErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DbHttpError'
    this.code = options.code
    this.retryable = options.retryable
    this.attempts = options.attempts
    this.status = options.status
    this.lastStatus = options.lastStatus
    this.nextSuggestedWaitMs = options.nextSuggestedWaitMs
    this.safeDetails = {
      redactedUrl: options.redactedUrl,
      transportName: options.transportName
    }
  }
}
