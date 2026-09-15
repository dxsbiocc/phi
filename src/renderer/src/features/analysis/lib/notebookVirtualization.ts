export type NotebookVirtualItem = {
  id: string
}

export type NotebookVirtualViewport = {
  scrollTop: number
  viewportHeight: number
}

export type NotebookVirtualWindow<T extends NotebookVirtualItem> = {
  enabled: boolean
  startIndex: number
  endIndex: number
  beforeHeight: number
  afterHeight: number
  totalHeight: number
  offsets: number[]
  heights: number[]
  items: Array<{ item: T; index: number }>
}

export const notebookVirtualEstimatedRowHeight = 220
export const notebookVirtualOverscanPx = 1200
export const notebookVirtualMinimumRowCount = 24

const minimumMeasuredRowHeight = 48

export function normalizedNotebookVirtualRowHeight(height: number): number {
  return Number.isFinite(height) && height > 0
    ? Math.max(minimumMeasuredRowHeight, Math.ceil(height))
    : notebookVirtualEstimatedRowHeight
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
  const estimatedRowHeight = Math.max(
    minimumMeasuredRowHeight,
    options.estimatedRowHeight ?? notebookVirtualEstimatedRowHeight
  )
  const overscanPx = Math.max(0, options.overscanPx ?? notebookVirtualOverscanPx)
  const minimumRowCount = Math.max(0, options.minimumRowCount ?? notebookVirtualMinimumRowCount)
  const heights = items.map((item) =>
    normalizedNotebookVirtualRowHeight(measuredHeights[item.id] ?? estimatedRowHeight)
  )
  const offsets = [0]
  for (const height of heights) {
    offsets.push(offsets[offsets.length - 1] + height)
  }
  const totalHeight = offsets[offsets.length - 1]
  const enabled = items.length >= minimumRowCount

  if (!enabled) {
    return {
      enabled,
      startIndex: 0,
      endIndex: items.length,
      beforeHeight: 0,
      afterHeight: 0,
      totalHeight,
      offsets,
      heights,
      items: items.map((item, index) => ({ item, index }))
    }
  }

  const scrollTop = Math.max(0, viewport.scrollTop)
  const viewportHeight = Math.max(0, viewport.viewportHeight)
  const visibleStart = Math.max(0, scrollTop - overscanPx)
  const visibleEnd = scrollTop + viewportHeight + overscanPx
  let startIndex = 0
  while (startIndex < items.length && offsets[startIndex + 1] < visibleStart) {
    startIndex += 1
  }

  let endIndex = startIndex
  while (endIndex < items.length && offsets[endIndex] <= visibleEnd) {
    endIndex += 1
  }
  endIndex = Math.min(items.length, Math.max(startIndex + 1, endIndex))

  return {
    enabled,
    startIndex,
    endIndex,
    beforeHeight: offsets[startIndex],
    afterHeight: Math.max(0, totalHeight - offsets[endIndex]),
    totalHeight,
    offsets,
    heights,
    items: items.slice(startIndex, endIndex).map((item, index) => ({
      item,
      index: startIndex + index
    }))
  }
}
