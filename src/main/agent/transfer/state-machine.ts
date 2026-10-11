import type { TransferState } from './types'

export class TransferStateError extends Error {
  readonly code = 'INVALID_STATE'

  constructor(from: TransferState, to: TransferState) {
    super(`Invalid transfer state transition: ${from} -> ${to}`)
    this.name = 'TransferStateError'
  }
}

const NEXT_STATES: Readonly<Record<TransferState, ReadonlySet<TransferState>>> = Object.freeze({
  queued: new Set<TransferState>(['preparing', 'cancelled', 'failed']),
  preparing: new Set<TransferState>(['transferring', 'cancelled', 'failed']),
  transferring: new Set<TransferState>(['verifying', 'paused', 'cancelled', 'failed']),
  verifying: new Set<TransferState>(['publishing', 'cancelled', 'failed']),
  publishing: new Set<TransferState>(['saved', 'cancelled', 'failed']),
  saved: new Set<TransferState>(),
  paused: new Set<TransferState>(['queued', 'cancelled', 'failed']),
  cancelled: new Set<TransferState>(),
  failed: new Set<TransferState>()
})

export function transitionTransferState(from: TransferState, to: TransferState): TransferState {
  if (!NEXT_STATES[from].has(to)) throw new TransferStateError(from, to)
  return to
}
