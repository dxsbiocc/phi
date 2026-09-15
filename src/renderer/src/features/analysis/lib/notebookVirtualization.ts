import {
  computeVirtualWindow,
  normalizedVirtualRowHeight,
  virtualMinimumMeasuredRowHeight,
  type VirtualListItem,
  type VirtualViewport,
  type VirtualWindow
} from '../../../lib/virtualWindow'

export type NotebookVirtualItem = VirtualListItem
export type NotebookVirtualViewport = VirtualViewport
export type NotebookVirtualWindow<T extends NotebookVirtualItem> = VirtualWindow<T>

export const notebookVirtualEstimatedRowHeight = 220
export const notebookVirtualOverscanPx = 1200
export const notebookVirtualMinimumRowCount = 24

export function normalizedNotebookVirtualRowHeight(height: number): number {
  return normalizedVirtualRowHeight(height, notebookVirtualEstimatedRowHeight)
}

export function notebookVirtualWindow<T extends NotebookVirtualItem>(
  items: T[],
  measuredHeights: Readonly<Record<string, number>>,
  viewport: NotebookVirtualViewport,
  options: {
    estimatedRowHeight?: number
    overscanPx?: number
    minimumRowCount?: number
  } = {}
): NotebookVirtualWindow<T> {
  return computeVirtualWindow(items, measuredHeights, viewport, {
    estimatedRowHeight: Math.max(
      virtualMinimumMeasuredRowHeight,
      options.estimatedRowHeight ?? notebookVirtualEstimatedRowHeight
    ),
    overscanPx: Math.max(0, options.overscanPx ?? notebookVirtualOverscanPx),
    minimumRowCount: Math.max(0, options.minimumRowCount ?? notebookVirtualMinimumRowCount)
  })
}
