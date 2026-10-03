import { useEffect } from 'react'
import type {
  BrowserRendererBridge,
  BrowserRendererEventEnvelope
} from '../../../../../shared/browserTypes'

export function browserPanelRequestMatchesSession(
  envelope: BrowserRendererEventEnvelope,
  activeSessionId: string | null
): boolean {
  return Boolean(
    activeSessionId &&
    envelope.sessionId === activeSessionId &&
    envelope.event.type === 'panelRequested'
  )
}

export function browserAppShellFailureMessage(
  envelope: BrowserRendererEventEnvelope
): string | null {
  return envelope.sessionId === null && envelope.event.type === 'appShellOpenFailed'
    ? '无法打开链接，请先选择一个会话或稍后重试。'
    : null
}

export function useBrowserPanelRequests(options: {
  bridge: BrowserRendererBridge
  activeSessionId: string | null
  onRequest(): void
  onFailure(message: string): void
}): void {
  const { bridge, activeSessionId, onRequest, onFailure } = options
  useEffect(
    () =>
      bridge.onEvent((envelope) => {
        if (browserPanelRequestMatchesSession(envelope, activeSessionId)) onRequest()
        const failureMessage = browserAppShellFailureMessage(envelope)
        if (failureMessage) onFailure(failureMessage)
      }),
    [activeSessionId, bridge, onFailure, onRequest]
  )
}
