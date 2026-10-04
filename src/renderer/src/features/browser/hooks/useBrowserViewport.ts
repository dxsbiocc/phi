import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { BrowserRendererBridge, BrowserViewport } from '../../../../../shared/browserTypes'

interface BrowserViewportRect {
  x: number
  y: number
  width: number
  height: number
}

export function browserViewportRectsOverlap(
  viewport: BrowserViewportRect,
  overlay: BrowserViewportRect
): boolean {
  if (viewport.width <= 0 || viewport.height <= 0 || overlay.width <= 0 || overlay.height <= 0) {
    return false
  }
  return (
    Math.min(viewport.x + viewport.width, overlay.x + overlay.width) >
      Math.max(viewport.x, overlay.x) &&
    Math.min(viewport.y + viewport.height, overlay.y + overlay.height) >
      Math.max(viewport.y, overlay.y)
  )
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

    const trustedOverlaySelector =
      '.MuiModal-root, .MuiPopover-root, [role="dialog"], [role="alertdialog"]'
    const hoverPreviewSelector = '[data-phi-workspace-sidebar-hover-preview]'
    const getUnobstructedRect = (): BrowserViewportRect | null => {
      const rect = contentRef.current?.getBoundingClientRect() ?? null
      if (!rect || document.querySelector(trustedOverlaySelector)) return null
      for (const preview of document.querySelectorAll(hoverPreviewSelector)) {
        const style = window.getComputedStyle(preview)
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          style.opacity === '0'
        ) {
          continue
        }
        if (browserViewportRectsOverlap(rect, preview.getBoundingClientRect())) return null
      }
      return rect
    }
    const scheduler = createBrowserViewportScheduler({
      bridge: options.bridge,
      sessionId: options.sessionId,
      sessionGeneration: options.sessionGeneration,
      tabId: options.tabId,
      // Recheck at frame delivery so a newly placed preview cannot be
      // covered by a viewport update queued before it appeared.
      getRect: getUnobstructedRect,
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id)
    })
    const observedPreviews = new Set<Element>()
    let observer: ResizeObserver | null = null
    const updateForTrustedOverlay = (): void => {
      const previews = new Set(document.querySelectorAll(hoverPreviewSelector))
      for (const preview of observedPreviews) {
        if (previews.has(preview)) continue
        observer?.unobserve(preview)
        observedPreviews.delete(preview)
      }
      for (const preview of previews) {
        if (observedPreviews.has(preview)) continue
        observer?.observe(preview)
        observedPreviews.add(preview)
      }
      if (document.querySelector(trustedOverlaySelector)) scheduler.hide()
      else scheduler.schedule()
    }
    observer =
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
      observedPreviews.clear()
      overlayObserver?.disconnect()
      window.removeEventListener('resize', onWindowResize)
      scheduler.dispose()
    }
  }, [options.bridge, options.enabled, options.sessionGeneration, options.sessionId, options.tabId])

  return contentRef
}
