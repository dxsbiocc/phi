import type { ReactNode } from 'react'

export interface ConfirmationOptions {
  title: ReactNode
  description?: ReactNode
  confirmLabel: ReactNode
  /** Renders the confirm action with the error palette for destructive operations. */
  destructive?: boolean
}

export interface PendingConfirmation {
  options: ConfirmationOptions
  resolve(confirmed: boolean): void
}

export interface ConfirmationController {
  getSnapshot(): PendingConfirmation | null
  subscribe(listener: () => void): () => void
  request(options: ConfirmationOptions): Promise<boolean>
  settle(confirmed: boolean, pending?: PendingConfirmation): void
}

/**
 * Promise-backed confirmation queue used by `useConfirmation`. Confirmations are
 * queued so overlapping requests cannot silently discard an earlier answer.
 */
export function createConfirmationController(): ConfirmationController {
  const queue: PendingConfirmation[] = []
  const listeners = new Set<() => void>()
  let snapshot: PendingConfirmation | null = null

  const publish = (): void => {
    snapshot = queue[0] ?? null
    for (const listener of listeners) listener()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    request: (options) =>
      new Promise<boolean>((resolve) => {
        queue.push({ options, resolve })
        publish()
      }),
    settle: (confirmed, pending) => {
      if (pending && queue[0] !== pending) return
      const current = queue.shift()
      if (!current) return
      publish()
      current.resolve(confirmed)
    }
  }
}
