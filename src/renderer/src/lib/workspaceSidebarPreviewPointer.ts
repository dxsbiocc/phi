export type PreviewPointerPosition = { x: number; y: number }
export type PreviewPointerBounds = { left: number; top: number; right: number; bottom: number }

let pointerPosition: PreviewPointerPosition | null = null

export function previewBoundsContainPointer(
  point: PreviewPointerPosition | null,
  bounds: PreviewPointerBounds,
  leftGap = 0
): boolean {
  return Boolean(
    point &&
    bounds.right > bounds.left &&
    bounds.bottom > bounds.top &&
    point.x >= bounds.left - leftGap &&
    point.x <= bounds.right &&
    point.y >= bounds.top &&
    point.y <= bounds.bottom
  )
}

export function setWorkspaceSidebarPointerPosition(point: PreviewPointerPosition | null): void {
  pointerPosition = point
}

function visible(element: Element | null): element is Element {
  if (!element) return false
  const style = window.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

export function hasVisibleWorkspaceSidebarDialog(): boolean {
  return (
    typeof document !== 'undefined' &&
    Array.from(document.querySelectorAll('[role="dialog"]')).some(
      (dialog) => visible(dialog) && dialog.getBoundingClientRect().width > 0
    )
  )
}

export function isWorkspaceSidebarPreviewDialogActive(): boolean {
  return (
    typeof document !== 'undefined' &&
    Boolean(
      document.querySelector(
        '[data-phi-workspace-sidebar-preview-region][data-phi-preview-dialog-active="true"]'
      )
    )
  )
}

/** Geometric containment remains true when a portalled title tooltip becomes the event target. */
export function isPointerWithinWorkspaceSidebarPreview(): boolean {
  if (!pointerPosition || typeof document === 'undefined' || hasVisibleWorkspaceSidebarDialog())
    return false
  const region =
    document.querySelector('[data-phi-workspace-sidebar-preview-region]') ??
    document.getElementById('workspace-sidebar-preview')
  const anchor = document.querySelector(
    '.app-activity-bar [aria-controls="workspace-sidebar-preview"]'
  )
  return (
    (visible(region) &&
      previewBoundsContainPointer(pointerPosition, region.getBoundingClientRect(), 6)) ||
    (visible(anchor) &&
      previewBoundsContainPointer(pointerPosition, anchor.getBoundingClientRect()))
  )
}

export function trackWorkspaceSidebarPointer(onChange: () => void): () => void {
  const update = (event: PointerEvent): void => {
    pointerPosition = { x: event.clientX, y: event.clientY }
    onChange()
  }
  const leave = (event: PointerEvent): void => {
    if (
      event.relatedTarget ||
      (event.clientX >= 0 &&
        event.clientX < window.innerWidth &&
        event.clientY >= 0 &&
        event.clientY < window.innerHeight)
    )
      return
    pointerPosition = null
    onChange()
  }
  const blur = (): void => {
    pointerPosition = null
    onChange()
  }
  document.addEventListener('pointermove', update, true)
  document.addEventListener('pointerover', update, true)
  document.addEventListener('pointerout', leave, true)
  window.addEventListener('blur', blur)
  return () => {
    document.removeEventListener('pointermove', update, true)
    document.removeEventListener('pointerover', update, true)
    document.removeEventListener('pointerout', leave, true)
    window.removeEventListener('blur', blur)
    pointerPosition = null
  }
}
