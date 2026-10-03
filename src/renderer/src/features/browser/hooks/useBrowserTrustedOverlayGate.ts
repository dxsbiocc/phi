import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BrowserRendererBridge } from '../../../../../shared/browserTypes'
import {
  createBrowserTrustedOverlayGate,
  hideActiveBrowserViewport,
  type BrowserTrustedOverlayKind,
  type BrowserTrustedOverlayRequest
} from '../lib/browserTrustedOverlayGate'

class BrowserViewportHider {
  #bridge: BrowserRendererBridge
  #sessionId: string | null
  #sessionGeneration: number

  constructor(bridge: BrowserRendererBridge, sessionId: string | null, sessionGeneration: number) {
    this.#bridge = bridge
    this.#sessionId = sessionId
    this.#sessionGeneration = sessionGeneration
  }

  update(bridge: BrowserRendererBridge, sessionId: string | null, sessionGeneration: number): void {
    this.#bridge = bridge
    this.#sessionId = sessionId
    this.#sessionGeneration = sessionGeneration
  }

  readonly hide = (): Promise<boolean> =>
    hideActiveBrowserViewport(this.#bridge, this.#sessionId, this.#sessionGeneration)
}

export function useBrowserTrustedOverlayGate(options: {
  bridge: BrowserRendererBridge
  activePhiSessionId: string | null
  activeSessionGeneration: number
  browserOpen: boolean
  closeBrowserPanel(): void
  onFailure(kind: BrowserTrustedOverlayKind): void
}): {
  suspended: boolean
  enqueue(request: BrowserTrustedOverlayRequest): void
  cancel(kind: BrowserTrustedOverlayKind, key?: string, notify?: boolean): void
} {
  const { bridge, browserOpen, closeBrowserPanel, onFailure } = options
  const browserOpenRef = useRef(browserOpen)
  const [viewportHider] = useState(
    () =>
      new BrowserViewportHider(bridge, options.activePhiSessionId, options.activeSessionGeneration)
  )
  useLayoutEffect(() => {
    browserOpenRef.current = browserOpen
    viewportHider.update(bridge, options.activePhiSessionId, options.activeSessionGeneration)
  }, [
    bridge,
    browserOpen,
    options.activePhiSessionId,
    options.activeSessionGeneration,
    viewportHider
  ])
  const [suspended, setSuspended] = useState(false)
  const gate = useMemo(
    () =>
      createBrowserTrustedOverlayGate({
        hide: viewportHider.hide,
        onHideFailure: () => {
          closeBrowserPanel()
        },
        onRequestFailure: onFailure,
        onSuspendedChange: setSuspended,
        setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clearTimer: (id) => window.clearTimeout(id),
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (id) => window.cancelAnimationFrame(id)
      }),
    [closeBrowserPanel, onFailure, viewportHider]
  )

  useEffect(() => () => gate.dispose(), [gate])
  const enqueue = useCallback(
    (request: BrowserTrustedOverlayRequest): void => {
      if (!browserOpenRef.current) {
        request.publish()
        return
      }
      gate.enqueue(request)
    },
    [gate]
  )
  const cancel = useCallback(
    (kind: BrowserTrustedOverlayKind, key?: string, notify?: boolean): void =>
      gate.cancel(kind, key, notify),
    [gate]
  )
  return { suspended, enqueue, cancel }
}
