export type ModelAccessReadOnlyOperation = 'set' | 'remove' | 'removeById' | 'upsert' | 'login'

export class ModelAccessReadOnlyError extends Error {
  readonly code = 'MODEL_ACCESS_READ_ONLY'

  constructor(readonly operation: ModelAccessReadOnlyOperation) {
    super(`Model credentials are desktop-owned; ${operation} is not available in the kernel.`)
    this.name = 'ModelAccessReadOnlyError'
  }
}

export class ModelAccessConfigurationError extends Error {
  readonly code = 'MODEL_ACCESS_INVALID_CONFIGURATION'

  constructor(message: string) {
    super(message)
    this.name = 'ModelAccessConfigurationError'
  }
}

export class ModelAccessWaitCancelledError extends Error {
  readonly code = 'MODEL_ACCESS_WAIT_CANCELLED'

  constructor(message = 'Waiting for model access was cancelled.') {
    super(message)
    this.name = 'ModelAccessWaitCancelledError'
  }
}

export class DesktopCredentialBrokerDisconnectedError extends Error {
  readonly code = 'DESKTOP_CREDENTIAL_BROKER_DISCONNECTED'

  constructor() {
    super('The desktop credential broker is not connected.')
    this.name = 'DesktopCredentialBrokerDisconnectedError'
  }
}

export class ModelConnectionLostError extends Error {
  readonly code = 'MODEL_CONNECTION_LOST'

  constructor() {
    super('model connection lost')
    this.name = 'ModelConnectionLostError'
  }
}
