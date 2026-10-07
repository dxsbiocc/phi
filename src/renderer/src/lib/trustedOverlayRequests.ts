export type TrustedOverlayRequest = (key: string, publish: () => void, onCancel: () => void) => void

export function createTrustedDialogRequestCoordinator(options: {
  request?: TrustedOverlayRequest
  cancel?: (key: string) => void
  onCancel?: (key: string) => void
}): {
  request(key: string, publish: () => void): void
  cancel(key: string): void
  dispose(): void
} {
  const pending = new Map<string, symbol>()
  const cancel = (key: string): void => {
    if (!pending.delete(key)) return
    options.cancel?.(key)
    options.onCancel?.(key)
  }
  return {
    request: (key, publish) => {
      cancel(key)
      const request = Symbol(key)
      pending.set(key, request)
      const guardedPublish = (): void => {
        if (pending.get(key) !== request) return
        pending.delete(key)
        publish()
      }
      const guardedCancel = (): void => {
        if (pending.get(key) !== request) return
        pending.delete(key)
        options.onCancel?.(key)
      }
      if (!options.request) {
        guardedPublish()
        return
      }
      try {
        options.request(key, guardedPublish, guardedCancel)
      } catch {
        if (pending.get(key) === request) cancel(key)
      }
    },
    cancel,
    dispose: () => {
      for (const key of [...pending.keys()]) cancel(key)
    }
  }
}
