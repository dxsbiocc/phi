import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BrowserRendererBridge } from '../../../../../shared/browserTypes'
import {
  createBrowserTrustedOverlayGate,
  hideActiveBrowserViewport,
  type BrowserTrustedOverlayKind,
  type BrowserTrustedOverlayRequest
} from '../lib/browserTrustedOverlayGate'

export function useBrowserTrustedOverlayGate(options: {
  bridge: BrowserRendererBridge
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
  useLayoutEffect(() => {
    browserOpenRef.current = browserOpen
  }, [browserOpen])
  const [suspended, setSuspended] = useState(false)
  const gate = useMemo(
    () =>
      createBrowserTrustedOverlayGate({
        hide: () => hideActiveBrowserViewport(bridge),
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
    [bridge, closeBrowserPanel, onFailure]
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
