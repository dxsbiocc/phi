import {
  computeVirtualWindow,
  normalizedVirtualRowHeight,
  virtualMinimumMeasuredRowHeight,
  type VirtualListItem,
  type VirtualViewport,
  type VirtualWindow
} from './virtualWindow'

export type ChatVirtualItem = VirtualListItem
export type ChatVirtualViewport = VirtualViewport
export type ChatVirtualWindow<T extends ChatVirtualItem> = VirtualWindow<T>

// Chat groups (tool groups, processing folds, bubbles) run taller than the
// average notebook cell and conversations can run to hundreds of turns before
// a user would ever notice, so the estimate/overscan/threshold below are more
// generous than the notebook's — the goal is to never virtualize a
// conversation short enough that a user would perceive any change, and to
// keep enough overscan that fast scrolling/streaming rarely reveals blank
// rows before they're measured.
export const chatVirtualEstimatedRowHeight = 160
export const chatVirtualOverscanPx = 1600
export const chatVirtualMinimumRowCount = 40

export function normalizedChatVirtualRowHeight(height: number): number {
  return normalizedVirtualRowHeight(height, chatVirtualEstimatedRowHeight)
}

export function chatVirtualWindow<T extends ChatVirtualItem>(
  items: T[],
  measuredHeights: Readonly<Record<string, number>>,
  viewport: ChatVirtualViewport,
  options: {
    estimatedRowHeight?: number
    overscanPx?: number
    minimumRowCount?: number
  } = {}
): ChatVirtualWindow<T> {
  return computeVirtualWindow(items, measuredHeights, viewport, {
    estimatedRowHeight: Math.max(
      virtualMinimumMeasuredRowHeight,
      options.estimatedRowHeight ?? chatVirtualEstimatedRowHeight
    ),
    overscanPx: Math.max(0, options.overscanPx ?? chatVirtualOverscanPx),
    minimumRowCount: Math.max(0, options.minimumRowCount ?? chatVirtualMinimumRowCount)
  })
}
