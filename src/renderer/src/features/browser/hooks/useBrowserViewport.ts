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

function isVisibleOverlayElement(element: Element): boolean {
  const style = window.getComputedStyle(element)
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.visibility !== 'collapse' &&
    style.opacity !== '0'
  )
}

export function browserViewportBlockedByOverlayRects(
  viewport: BrowserViewportRect,
  hasBlockingDialog: boolean,
  overlayRects: readonly BrowserViewportRect[]
): boolean {
  if (hasBlockingDialog) return true
  return overlayRects.some((overlay) => browserViewportRectsOverlap(viewport, overlay))
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

    // Full-window dialogs hide the native WebContentsView unconditionally; non-dialog popovers
    // (e.g. Terminal menus in another workbench slot) only hide it when their paper overlaps.
    const blockingDialogSelector =
      '.MuiDialog-root, .MuiModal-root:not(.MuiPopover-root), [role="dialog"], [role="alertdialog"]'
    const positionedOverlaySelector =
      '[data-phi-workspace-sidebar-hover-preview], .MuiPopover-root .MuiPaper-root'
    const getUnobstructedRect = (): BrowserViewportRect | null => {
      const rect = contentRef.current?.getBoundingClientRect() ?? null
      if (!rect) return null
      const overlayRects: BrowserViewportRect[] = []
      for (const overlay of document.querySelectorAll(positionedOverlaySelector)) {
        if (!isVisibleOverlayElement(overlay)) continue
        overlayRects.push(overlay.getBoundingClientRect())
      }
      if (
        browserViewportBlockedByOverlayRects(
          rect,
          Boolean(document.querySelector(blockingDialogSelector)),
          overlayRects
        )
      ) {
        return null
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
    const observedOverlays = new Set<Element>()
    let observer: ResizeObserver | null = null
    const updateForTrustedOverlay = (): void => {
      const overlays = new Set(document.querySelectorAll(positionedOverlaySelector))
      for (const overlay of observedOverlays) {
        if (overlays.has(overlay)) continue
        observer?.unobserve(overlay)
        observedOverlays.delete(overlay)
      }
      for (const overlay of overlays) {
        if (observedOverlays.has(overlay)) continue
        observer?.observe(overlay)
        observedOverlays.add(overlay)
      }
      if (getUnobstructedRect() === null) scheduler.hide()
      else scheduler.schedule()
    }
    observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateForTrustedOverlay)
    if (contentRef.current) {
      observer?.observe(contentRef.current)
      const workbenchRoot = contentRef.current.closest('[data-phi-workspace-tools-side-panel]')
      if (workbenchRoot) observer?.observe(workbenchRoot)
    }
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
      observedOverlays.clear()
      overlayObserver?.disconnect()
      window.removeEventListener('resize', onWindowResize)
      scheduler.dispose()
    }
  }, [options.bridge, options.enabled, options.sessionGeneration, options.sessionId, options.tabId])

  return contentRef
}
