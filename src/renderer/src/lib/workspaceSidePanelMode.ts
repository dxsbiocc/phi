export type WorkspaceSidePanelMode = 'jobs' | 'terminal' | 'browser'

export interface WorkspaceSidePanelState {
  slots: WorkspaceSidePanelMode[]
  maximized: WorkspaceSidePanelMode | null
  active: WorkspaceSidePanelMode | null
}

export const emptyWorkspaceSidePanelState: WorkspaceSidePanelState = {
  slots: [],
  maximized: null,
  active: null
}

export function workspaceSidePanelWidthForViewport(options: {
  preferredWidth: number
  viewportWidth: number
  navigationWidth: number
  minimumMainWidth?: number
  compactMinimum?: number
  maximum?: number
}): number {
  const minimumMainWidth = options.minimumMainWidth ?? 320
  const compactMinimum = options.compactMinimum ?? 240
  const maximum = options.maximum ?? 520
  const availableAfterNavigation = Math.max(0, options.viewportWidth - options.navigationWidth)
  const widthThatPreservesMain = Math.max(
    compactMinimum,
    availableAfterNavigation - minimumMainWidth
  )
  return Math.max(
    0,
    Math.min(options.preferredWidth, maximum, availableAfterNavigation, widthThatPreservesMain)
  )
}

export function openWorkspaceSidePanelMode(
  current: WorkspaceSidePanelState,
  requested: WorkspaceSidePanelMode
): WorkspaceSidePanelState {
  if (current.slots.includes(requested)) {
    return current.active === requested && current.maximized === null
      ? current
      : { ...current, maximized: null, active: requested }
  }

  const slots =
    current.slots.length < 2 ? [...current.slots, requested] : [current.slots[0], requested]
  return { slots, maximized: null, active: requested }
}

export function closeWorkspaceSidePanelMode(
  current: WorkspaceSidePanelState,
  requested: WorkspaceSidePanelMode
): WorkspaceSidePanelState {
  if (!current.slots.includes(requested)) return current
  const slots = current.slots.filter((mode) => mode !== requested)
  return {
    slots,
    maximized: current.maximized === requested ? null : current.maximized,
    active:
      current.active === requested
        ? (slots.at(-1) ?? null)
        : current.active && slots.includes(current.active)
          ? current.active
          : (slots.at(-1) ?? null)
  }
}

export function toggleWorkspaceSidePanelMode(
  current: WorkspaceSidePanelState,
  requested: WorkspaceSidePanelMode
): WorkspaceSidePanelState {
  return current.slots.includes(requested)
    ? closeWorkspaceSidePanelMode(current, requested)
    : openWorkspaceSidePanelMode(current, requested)
}

export function toggleWorkspaceSidePanelModeForLayout(
  current: WorkspaceSidePanelState,
  requested: WorkspaceSidePanelMode,
  splitVisible: boolean
): WorkspaceSidePanelState {
  const hiddenCompactSlot =
    !splitVisible &&
    current.slots.length > 1 &&
    current.slots.includes(requested) &&
    current.active !== requested
  return hiddenCompactSlot
    ? openWorkspaceSidePanelMode(current, requested)
    : toggleWorkspaceSidePanelMode(current, requested)
}

export function toggleWorkspaceSidePanelMaximized(
  current: WorkspaceSidePanelState,
  requested: WorkspaceSidePanelMode
): WorkspaceSidePanelState {
  if (!current.slots.includes(requested)) return current
  return {
    ...current,
    maximized: current.maximized === requested ? null : requested,
    active: requested
  }
}
