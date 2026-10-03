import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { BrowserRendererBridge, BrowserViewport } from '../../../../../shared/browserTypes'

interface BrowserViewportRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserViewportScheduler {
  schedule(): void
  hide(): void
  dispose(): void
}

export function createBrowserViewportScheduler(options: {
  bridge: BrowserRendererBridge
  sessionId: string
  sessionGeneration: number
  tabId: string
  getRect: () => BrowserViewportRect | null
  requestFrame: (callback: (time: number) => void) => number
  cancelFrame: (id: number) => void
}): BrowserViewportScheduler {
  let disposed = false
  let frameId: number | null = null

  const send = (viewport: BrowserViewport | null): void => {
    void options.bridge
      .setViewport({
        sessionId: options.sessionId,
        sessionGeneration: options.sessionGeneration,
        tabId: options.tabId,
        viewport
      })
      .catch(() => undefined)
  }
  const measure = (): void => {
    frameId = null
    if (disposed) return
    try {
      const rect = options.getRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        send(null)
        return
      }
      send({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    } catch {
      send(null)
    }
  }
  const hide = (): void => {
    if (disposed) return
    if (frameId !== null) options.cancelFrame(frameId)
    frameId = null
    send(null)
  }

  return {
    schedule: () => {
      if (disposed || frameId !== null) return
      frameId = options.requestFrame(measure)
    },
    hide,
    dispose: () => {
      if (disposed) return
      hide()
      disposed = true
    }
  }
}

export function useBrowserViewport(options: {
  bridge: BrowserRendererBridge
  sessionId: string | null
  sessionGeneration: number
  tabId: string | null
  enabled: boolean
}): RefObject<HTMLDivElement | null> {
  const contentRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!options.sessionId || !options.tabId) return
    if (!options.enabled) {
      void options.bridge
        .setViewport({
          sessionId: options.sessionId,
          sessionGeneration: options.sessionGeneration,
          tabId: options.tabId,
          viewport: null
        })
        .catch(() => undefined)
      return
    }

    const scheduler = createBrowserViewportScheduler({
      bridge: options.bridge,
      sessionId: options.sessionId,
      sessionGeneration: options.sessionGeneration,
      tabId: options.tabId,
      getRect: () => contentRef.current?.getBoundingClientRect() ?? null,
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id)
    })
    const trustedOverlaySelector =
      '.MuiModal-root, .MuiPopover-root, [role="dialog"], [role="alertdialog"]'
    const updateForTrustedOverlay = (): void => {
      if (document.querySelector(trustedOverlaySelector)) scheduler.hide()
      else scheduler.schedule()
    }
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateForTrustedOverlay)
    if (contentRef.current) observer?.observe(contentRef.current)
    const overlayObserver =
      typeof MutationObserver === 'undefined' ? null : new MutationObserver(updateForTrustedOverlay)
    overlayObserver?.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
    })
    const onWindowResize = (): void => updateForTrustedOverlay()
    window.addEventListener('resize', onWindowResize)
    updateForTrustedOverlay()

    return () => {
      observer?.disconnect()
      overlayObserver?.disconnect()
      window.removeEventListener('resize', onWindowResize)
      scheduler.dispose()
    }
  }, [options.bridge, options.enabled, options.sessionGeneration, options.sessionId, options.tabId])

  return contentRef
}
