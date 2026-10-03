import type { TerminalErrorCode } from '../../shared/terminalTypes'

export class TerminalError extends Error {
  constructor(
    public readonly code: TerminalErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'TerminalError'
  }
}
