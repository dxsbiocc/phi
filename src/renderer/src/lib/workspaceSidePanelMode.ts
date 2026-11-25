export type WorkspaceSidePanelMode = 'jobs' | 'messages' | 'terminal' | 'browser'

export const MAX_WORKSPACE_SIDE_PANEL_SLOTS = 4

export interface WorkspaceSidePanelSlotPlacement {
  columnCount: 1 | 2
  rowCount: 1 | 2
  gridColumn: number
  gridRow: number | string
  spansFullColumn: boolean
}

export type WorkspaceSidePanelColumns = [WorkspaceSidePanelMode[], WorkspaceSidePanelMode[]]

export interface WorkspaceSidePanelState {
  slots: WorkspaceSidePanelMode[]
  /**
   * Preserves independent [left, right] column membership when 3 panels remain with 1 panel
   * in the left column and 2 in the right column (after closing a left-column panel from 4).
   */
  columns?: WorkspaceSidePanelColumns
  maximized: WorkspaceSidePanelMode | null
  active: WorkspaceSidePanelMode | null
}

export const emptyWorkspaceSidePanelState: WorkspaceSidePanelState = {
  slots: [],
  maximized: null,
  active: null
}

export function resolveWorkspaceSidePanelColumns(
  slots: readonly WorkspaceSidePanelMode[],
  columns?: readonly [readonly WorkspaceSidePanelMode[], readonly WorkspaceSidePanelMode[]]
): WorkspaceSidePanelColumns {
  if (slots.length <= 2) return [[...slots], []]
  if (
    columns &&
    columns[0].length > 0 &&
    columns[1].length > 0 &&
    columns[0].length + columns[1].length === slots.length
  ) {
    return [[...columns[0]], [...columns[1]]]
  }
  return [slots.slice(0, 2), slots.slice(2, 4)]
}

function canonicalColumnsProperty(
  left: WorkspaceSidePanelMode[],
  right: WorkspaceSidePanelMode[]
): { columns?: WorkspaceSidePanelColumns } {
  const total = left.length + right.length
  if (total > 2 && left.length === 1 && right.length === 2) {
    return { columns: [left, right] }
  }
  return {}
}

/**
 * Maps up to 4 visible slots into 1 or 2 right-hand columns:
 * - 1 slot:  [0] full height
 * - 2 slots: [0] top, [1] bottom in column 1
 * - 3 slots: [2, 1] by default, or [1, 2] when `columns` keeps 1 on the left and 2 on the right
 * - 4 slots: [0, 1] stacked in column 1; [2, 3] stacked in column 2
 */
export function workspaceSidePanelSlotPlacement(
  index: number,
  total: number,
  columns?: readonly [readonly WorkspaceSidePanelMode[], readonly WorkspaceSidePanelMode[]]
): WorkspaceSidePanelSlotPlacement {
  if (total <= 1) {
    return { columnCount: 1, rowCount: 1, gridColumn: 1, gridRow: 1, spansFullColumn: true }
  }
  if (total === 2) {
    return {
      columnCount: 1,
      rowCount: 2,
      gridColumn: 1,
      gridRow: index === 0 ? 1 : 2,
      spansFullColumn: false
    }
  }
  const leftCount =
    columns &&
    columns[0].length > 0 &&
    columns[1].length > 0 &&
    columns[0].length + columns[1].length === total
      ? columns[0].length
      : 2
  const rightCount = total - leftCount
  if (index < leftCount) {
    return {
      columnCount: 2,
      rowCount: 2,
      gridColumn: 1,
      gridRow: leftCount === 1 ? '1 / -1' : index + 1,
      spansFullColumn: leftCount === 1
    }
  }
  const rightIndex = index - leftCount
  return {
    columnCount: 2,
    rowCount: 2,
    gridColumn: 2,
    gridRow: rightCount === 1 ? '1 / -1' : rightIndex + 1,
    spansFullColumn: rightCount === 1
  }
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

  const [left, right] = resolveWorkspaceSidePanelColumns(current.slots, current.columns)
  if (left.length < 2) {
    left.push(requested)
  } else if (right.length < 2) {
    right.push(requested)
  } else {
    right[1] = requested
  }
  const slots = [...left, ...right]
  return {
    slots,
    ...canonicalColumnsProperty(left, right),
    maximized: null,
    active: requested
  }
}

export function closeWorkspaceSidePanelMode(
  current: WorkspaceSidePanelState,
  requested: WorkspaceSidePanelMode
): WorkspaceSidePanelState {
  if (!current.slots.includes(requested)) return current
  const [currentLeft, currentRight] = resolveWorkspaceSidePanelColumns(
    current.slots,
    current.columns
  )
  const rawLeft = currentLeft.filter((mode) => mode !== requested)
  const rawRight = currentRight.filter((mode) => mode !== requested)
  const total = rawLeft.length + rawRight.length
  const [left, right]: WorkspaceSidePanelColumns =
    total <= 2 ? [[...rawLeft, ...rawRight], []] : [rawLeft, rawRight]
  const slots = [...left, ...right]
  return {
    slots,
    ...canonicalColumnsProperty(left, right),
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
  const hiddenBehindMaximized =
    current.maximized !== null &&
    current.maximized !== requested &&
    current.slots.includes(requested)
  const hiddenCompactSlot =
    !splitVisible &&
    current.slots.length > 1 &&
    current.slots.includes(requested) &&
    current.active !== requested
  return hiddenBehindMaximized || hiddenCompactSlot
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
