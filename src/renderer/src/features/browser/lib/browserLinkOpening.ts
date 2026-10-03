import type { BrowserOutcome, BrowserUiCommand } from '../../../../../shared/browserTypes'

export interface BrowserLinkOpeningCoordinator {
  open(url: string): Promise<void>
  invalidate(): void
}

interface BrowserLinkOpeningCoordinatorOptions {
  execute(command: Extract<BrowserUiCommand, { type: 'open' }>): Promise<BrowserOutcome>
  nextRequestId(): string
  getActiveSessionId(): string | null
  openBrowserPanel(): void
  showFailure(): void
}

export function createBrowserLinkOpeningCoordinator(
  options: BrowserLinkOpeningCoordinatorOptions
): BrowserLinkOpeningCoordinator {
  let intent = 0

  const isCurrent = (openingIntent: number, sessionId: string): boolean =>
    openingIntent === intent && options.getActiveSessionId() === sessionId

  return {
    async open(url) {
      const openingIntent = ++intent
      const sessionId = options.getActiveSessionId()
      if (!sessionId) {
        if (openingIntent === intent) options.showFailure()
        return
      }

      let outcome: BrowserOutcome
      try {
        outcome = await options.execute({ type: 'open', requestId: options.nextRequestId(), url })
      } catch {
        if (isCurrent(openingIntent, sessionId)) options.showFailure()
        return
      }

      if (!isCurrent(openingIntent, sessionId)) return
      if (!outcome.ok || outcome.snapshot.sessionId !== sessionId) {
        options.showFailure()
        return
      }
      options.openBrowserPanel()
    },
    invalidate() {
      intent += 1
    }
  }
}
