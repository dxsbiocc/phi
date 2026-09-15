import {
  computeVirtualWindow,
  normalizedVirtualRowHeight,
  virtualMinimumMeasuredRowHeight,
  type VirtualListItem,
  type VirtualViewport,
  type VirtualWindow
} from './virtualWindow'

export type FileTreeVirtualItem = VirtualListItem
export type FileTreeVirtualViewport = VirtualViewport
export type FileTreeVirtualWindow<T extends FileTreeVirtualItem> = VirtualWindow<T>

// File tree rows are small, near-fixed-height single lines (an icon and a
// name), so the estimate is tight and overscan can stay modest. A directory
// listing is capped at 400 entries server-side, but a user can expand several
// large directories at once — the threshold below only kicks in once that
// aggregate gets large enough that rendering every row would matter.
export const fileTreeVirtualEstimatedRowHeight = 32
export const fileTreeVirtualOverscanPx = 800
export const fileTreeVirtualMinimumRowCount = 150

export function normalizedFileTreeVirtualRowHeight(height: number): number {
  return normalizedVirtualRowHeight(height, fileTreeVirtualEstimatedRowHeight)
}

export function fileTreeVirtualWindow<T extends FileTreeVirtualItem>(
  items: T[],
  measuredHeights: Readonly<Record<string, number>>,
  viewport: FileTreeVirtualViewport,
  options: {
    estimatedRowHeight?: number
    overscanPx?: number
    minimumRowCount?: number
  } = {}
): FileTreeVirtualWindow<T> {
  return computeVirtualWindow(items, measuredHeights, viewport, {
    estimatedRowHeight: Math.max(
      virtualMinimumMeasuredRowHeight,
      options.estimatedRowHeight ?? fileTreeVirtualEstimatedRowHeight
    ),
    overscanPx: Math.max(0, options.overscanPx ?? fileTreeVirtualOverscanPx),
    minimumRowCount: Math.max(0, options.minimumRowCount ?? fileTreeVirtualMinimumRowCount)
  })
}
