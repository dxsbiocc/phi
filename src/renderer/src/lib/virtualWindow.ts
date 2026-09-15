// Generic windowing math shared by list views that render a huge, variable-height
// item list (notebook cells, chat messages) and want to keep the DOM node count
// bounded without a full virtualization library. See
// features/analysis/lib/notebookVirtualization.ts and lib/chatVirtualization.ts
// for the per-feature defaults built on top of this.

export type VirtualListItem = {
  id: string
}

export type VirtualViewport = {
  scrollTop: number
  viewportHeight: number
}

export type VirtualWindow<T extends VirtualListItem> = {
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

export const virtualMinimumMeasuredRowHeight = 48

export function normalizedVirtualRowHeight(height: number, estimatedRowHeight: number): number {
  return Number.isFinite(height) && height > 0
    ? Math.max(virtualMinimumMeasuredRowHeight, Math.ceil(height))
    : estimatedRowHeight
}

export function computeVirtualWindow<T extends VirtualListItem>(
  items: T[],
  measuredHeights: Readonly<Record<string, number>>,
  viewport: VirtualViewport,
  options: {
    estimatedRowHeight: number
    overscanPx: number
    minimumRowCount: number
  }
): VirtualWindow<T> {
  const { estimatedRowHeight, overscanPx, minimumRowCount } = options
  const heights = items.map((item) =>
    normalizedVirtualRowHeight(measuredHeights[item.id] ?? estimatedRowHeight, estimatedRowHeight)
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
