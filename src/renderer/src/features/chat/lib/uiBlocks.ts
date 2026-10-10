import {
  uiBlocksDetailsSchema,
  type TableUiBlock,
  type UiBlocks
} from '../../../../../shared/uiBlockTypes'

export type TableSortDirection = 'asc' | 'desc'

export function sortTableRows(
  rows: readonly TableUiBlock['rows'][number][],
  key: string,
  direction: TableSortDirection
): TableUiBlock['rows'] {
  return [...rows].sort((left, right) => {
    const leftValue = left[key]
    const rightValue = right[key]
    if (leftValue === null || leftValue === undefined) {
      return rightValue === null || rightValue === undefined ? 0 : 1
    }
    if (rightValue === null || rightValue === undefined) return -1
    const comparison =
      typeof leftValue === 'number' && typeof rightValue === 'number'
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), 'zh-CN', {
            numeric: true,
            sensitivity: 'base'
          })
    return direction === 'asc' ? comparison : -comparison
  })
}

export interface UiBlocksItem {
  id: string
  role: 'ui_blocks'
  runId?: string
  createdAt?: string
  blocks: UiBlocks | null
}

type UiBlocksToolEvent = {
  type?: string
  toolCallId?: string
  runId?: string
  createdAt?: string
  details?: unknown
  result?: unknown
}

export function uiBlocksItemFromToolEvent(event: UiBlocksToolEvent): UiBlocksItem | null {
  if (!event.toolCallId) return null
  const parsed = uiBlocksDetailsSchema.safeParse(detailsFromEvent(event))
  if (!parsed.success) return null
  return itemFrom(event, parsed.data.blocks)
}

export function unavailableUiBlocksItemFromToolEvent(
  event: UiBlocksToolEvent
): UiBlocksItem | null {
  if (!event.toolCallId) return null
  const details = detailsFromEvent(event)
  if (!hasUiBlocksKind(details) || uiBlocksDetailsSchema.safeParse(details).success) return null
  return itemFrom(event, null)
}

function itemFrom(event: UiBlocksToolEvent, blocks: UiBlocks | null): UiBlocksItem {
  return {
    id: `ui-blocks-${event.toolCallId}`,
    role: 'ui_blocks',
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.createdAt ? { createdAt: event.createdAt } : {}),
    blocks
  }
}

function detailsFromEvent(event: UiBlocksToolEvent): unknown {
  if (event.details !== undefined) return event.details
  if (!event.result || typeof event.result !== 'object' || Array.isArray(event.result))
    return undefined
  return (event.result as { details?: unknown }).details
}

function hasUiBlocksKind(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === 'ui_blocks'
  )
}
