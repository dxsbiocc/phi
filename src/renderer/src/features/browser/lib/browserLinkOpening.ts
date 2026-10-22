import type {
  BrowserErrorCode,
  BrowserOutcome,
  BrowserUiCommand
} from '../../../../../shared/browserTypes'
import { browserErrorMessage } from './browserPanelState'
import { browserUi } from './browserUi'

export interface BrowserLinkOpeningCoordinator {
  open(url: string): Promise<void>
  invalidate(): void
}

export type BrowserLinkOpenFailure =
  { kind: 'no-session' } | { kind: 'unavailable' } | { kind: 'browser'; code: BrowserErrorCode }

interface BrowserLinkOpeningCoordinatorOptions {
  execute(command: Extract<BrowserUiCommand, { type: 'open' }>): Promise<BrowserOutcome>
  nextRequestId(): string
  getActiveSessionId(): string | null
  openBrowserPanel(): void
  showFailure(url: string, failure: BrowserLinkOpenFailure): void
}

export function browserLinkFailureMessage(failure: BrowserLinkOpenFailure): string {
  if (failure.kind === 'no-session') return browserUi.unableToOpenLinkInApp
  if (failure.kind === 'unavailable') {
    return browserUi.browserIsTemporarilyUnavailablePleaseTryAgainLater
  }
  return browserErrorMessage({ code: failure.code })
}

export function createBrowserLinkOpeningCoordinator(
  options: BrowserLinkOpeningCoordinatorOptions
): BrowserLinkOpeningCoordinator {
  let intent = 0

  const isCurrent = (openingIntent: number, sessionId: string): boolean =>
    openingIntent === intent && options.getActiveSessionId() === sessionId

  const report = (
    openingIntent: number,
    sessionId: string | null,
    url: string,
    failure: BrowserLinkOpenFailure
  ): void => {
    const current =
      openingIntent === intent && (sessionId === null || options.getActiveSessionId() === sessionId)
    if (!current) return
    if (
      failure.kind === 'browser' &&
      sessionId !== null &&
      (failure.code === 'NAVIGATION_FAILED' || failure.code === 'RENDERER_CRASHED')
    ) {
      options.openBrowserPanel()
    }
    options.showFailure(url, failure)
  }

  return {
    async open(url) {
      const openingIntent = ++intent
      const sessionId = options.getActiveSessionId()
      if (!sessionId) {
        report(openingIntent, null, url, { kind: 'no-session' })
        return
      }

      let outcome: BrowserOutcome
      try {
        outcome = await options.execute({ type: 'open', requestId: options.nextRequestId(), url })
      } catch {
        report(openingIntent, sessionId, url, { kind: 'unavailable' })
        return
      }

      if (!isCurrent(openingIntent, sessionId)) return
      if (!outcome.ok || outcome.snapshot.sessionId !== sessionId) {
        const failure: BrowserLinkOpenFailure =
          !outcome.ok && outcome.snapshot.sessionId === sessionId
            ? { kind: 'browser', code: outcome.error.code }
            : { kind: 'unavailable' }
        report(openingIntent, sessionId, url, failure)
        return
      }
      options.openBrowserPanel()
    },
    invalidate() {
      intent += 1
    }
  }
}
