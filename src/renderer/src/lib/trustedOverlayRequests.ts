export type TrustedOverlayRequest = (key: string, publish: () => void, onCancel: () => void) => void

export function createTrustedDialogRequestCoordinator(options: {
  request?: TrustedOverlayRequest
  cancel?: (key: string) => void
}): {
  request(key: string, publish: () => void): void
  cancel(key: string): void
  dispose(): void
} {
  const pending = new Set<string>()
  const cancel = (key: string): void => {
    if (!pending.delete(key)) return
    options.cancel?.(key)
  }
  return {
    request: (key, publish) => {
      cancel(key)
      pending.add(key)
      const guardedPublish = (): void => {
        if (!pending.delete(key)) return
        publish()
      }
      if (!options.request) {
        guardedPublish()
        return
      }
      try {
        options.request(key, guardedPublish, () => pending.delete(key))
      } catch {
        pending.delete(key)
      }
    },
    cancel,
    dispose: () => {
      for (const key of [...pending]) cancel(key)
    }
  }
}
