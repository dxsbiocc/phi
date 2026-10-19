import { useCallback, useEffect, useState, type MouseEvent } from 'react'

import {
  closeWorkspaceSidePanelMode,
  emptyWorkspaceSidePanelState,
  openWorkspaceSidePanelMode,
  toggleWorkspaceSidePanelMaximized,
  toggleWorkspaceSidePanelModeForLayout,
  workspaceSidePanelWidthForViewport,
  type WorkspaceSidePanelMode,
  type WorkspaceSidePanelState
} from '../workspaceSidePanelMode'

/**
 * Owns the docked workspace side panel: which modes are open, how wide it is,
 * whether it docks or floats, and the drag-to-resize gesture.
 *
 * It does not decide *what* each slot renders, and it does not know about the
 * browser link coordinator — callers that must react to a toggle wrap the
 * returned actions instead of the hook learning about them.
 */

/** Width of the docked panel before the user drags it. */
const defaultWorkspaceSidePanelWidth = 340
export const minWorkspaceSidePanelWidth = 240
export const maxWorkspaceSidePanelWidth = 520
/** Below this viewport width the panel floats over the workspace instead of docking. */
const overlayViewportWidth = 1100
/** Two slots may share the dock only when the window is this large. */
const splitViewportWidth = 1200
const splitViewportHeight = 640
/** Gap kept between a floating panel and the window edge. */
const overlayViewportGutter = 16

type ViewportSize = { width: number; height: number }

function readViewportSize(): ViewportSize {
  return { width: window.innerWidth, height: window.innerHeight }
}

/**
 * Drags the docked panel wider or narrower. The width is applied live and
 * clamped to the same bounds the layout uses, so a drag can never produce a
 * panel the responsive rules would immediately override.
 */
function beginSidePanelResize(
  event: MouseEvent<HTMLDivElement>,
  startWidth: number,
  applyWidth: (width: number) => void
): void {
  event.preventDefault()
  const startX = event.clientX
  const onMouseMove = (moveEvent: globalThis.MouseEvent): void => {
    const delta = moveEvent.clientX - startX
    applyWidth(
      Math.min(maxWorkspaceSidePanelWidth, Math.max(minWorkspaceSidePanelWidth, startWidth - delta))
    )
  }
  const onMouseUp = (): void => {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

export type WorkspaceSidePanelController = {
  state: WorkspaceSidePanelState
  slots: WorkspaceSidePanelMode[]
  /** True when no slot is open, i.e. the main column owns the full width. */
  collapsed: boolean
  /** Whether two slots may be shown side by side at the current window size. */
  canSplit: boolean
  /** The panel currently floats above the workspace instead of docking beside it. */
  overlay: boolean
  /** Rendered width, already clamped to the viewport. */
  activeWidth: number
  /** In a narrow window with several slots, the one that may stay visible. */
  singleVisibleMode: WorkspaceSidePanelMode | null
  treeRevision: number
  open: (mode: WorkspaceSidePanelMode) => void
  close: (mode: WorkspaceSidePanelMode) => void
  toggleForLayout: (mode: WorkspaceSidePanelMode) => void
  toggleMaximized: (mode: WorkspaceSidePanelMode) => void
  /** Bumps the revision so file trees reload what they show. */
  refreshTree: () => void
  startResize: (event: MouseEvent<HTMLDivElement>) => void
}

export function useWorkspaceSidePanel(options: {
  /** Width already taken by the activity bar and the navigation sidebar. */
  navigationWidth: number
}): WorkspaceSidePanelController {
  const { navigationWidth } = options
  const [viewport, setViewport] = useState<ViewportSize>(readViewportSize)
  const [state, setState] = useState<WorkspaceSidePanelState>(emptyWorkspaceSidePanelState)
  const [width, setWidth] = useState(defaultWorkspaceSidePanelWidth)
  const [treeRevision, setTreeRevision] = useState(0)

  useEffect(() => {
    const onResize = (): void => setViewport(readViewportSize())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const canSplit = viewport.width >= splitViewportWidth && viewport.height >= splitViewportHeight
  const slots = state.slots
  const collapsed = slots.length === 0
  const effectiveWidth = workspaceSidePanelWidthForViewport({
    preferredWidth: width,
    viewportWidth: viewport.width,
    navigationWidth,
    compactMinimum: minWorkspaceSidePanelWidth,
    maximum: maxWorkspaceSidePanelWidth
  })
  const overlay =
    viewport.width < overlayViewportWidth || effectiveWidth < minWorkspaceSidePanelWidth
  const activeWidth = overlay
    ? Math.min(width, Math.max(0, viewport.width - overlayViewportGutter))
    : effectiveWidth
  const singleVisibleMode =
    !canSplit && slots.length > 1 ? (state.active ?? slots.at(-1) ?? null) : null

  const open = useCallback((mode: WorkspaceSidePanelMode): void => {
    setState((current) => openWorkspaceSidePanelMode(current, mode))
  }, [])
  const close = useCallback((mode: WorkspaceSidePanelMode): void => {
    setState((current) => closeWorkspaceSidePanelMode(current, mode))
  }, [])
  const toggleForLayout = useCallback(
    (mode: WorkspaceSidePanelMode): void => {
      setState((current) => toggleWorkspaceSidePanelModeForLayout(current, mode, canSplit))
    },
    [canSplit]
  )
  const toggleMaximized = useCallback((mode: WorkspaceSidePanelMode): void => {
    setState((current) => toggleWorkspaceSidePanelMaximized(current, mode))
  }, [])
  const refreshTree = useCallback((): void => {
    setTreeRevision((value) => value + 1)
  }, [])
  const startResize = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => beginSidePanelResize(event, width, setWidth),
    [width]
  )

  return {
    state,
    slots,
    collapsed,
    canSplit,
    overlay,
    activeWidth,
    singleVisibleMode,
    treeRevision,
    open,
    close,
    toggleForLayout,
    toggleMaximized,
    refreshTree,
    startResize
  }
}
