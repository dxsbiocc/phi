import { notebookVirtualEstimatedRowHeight } from './notebookVirtualization'

export type NotebookViewState = {
  scrollTop: number
  viewportHeight: number
  rowHeights: Record<string, number>
  anchor: { cellId: string; offset: number } | null
}

export type NotebookViewStateStore = Map<string, NotebookViewState>

export function notebookViewStateKey(scope: string, path: string | null): string | null {
  return path ? JSON.stringify([scope, path]) : null
}

export function rememberNotebookViewState(
  store: NotebookViewStateStore,
  key: string,
  state: NotebookViewState
): void {
  store.delete(key)
  store.set(key, state)
  while (store.size > 50) store.delete(store.keys().next().value!)
}

export function notebookViewAnchor(
  cells: ReadonlyArray<{ id: string }>,
  heights: Readonly<Record<string, number>>,
  scrollTop: number
): NotebookViewState['anchor'] {
  let top = 0
  for (const [index, cell] of cells.entries()) {
    const height = heights[cell.id] ?? notebookVirtualEstimatedRowHeight
    if (top + height > scrollTop || index === cells.length - 1) {
      return { cellId: cell.id, offset: scrollTop - top }
    }
    top += height
  }
  return null
}

export function notebookViewScrollTop(
  state: NotebookViewState,
  cells: ReadonlyArray<{ id: string }>,
  heights: Readonly<Record<string, number>>
): number {
  let top = 0
  for (const cell of cells) {
    if (cell.id === state.anchor?.cellId) return top + state.anchor.offset
    top += heights[cell.id] ?? notebookVirtualEstimatedRowHeight
  }
  return state.scrollTop
}

export function notebookVirtualListScrollTop(
  scrollViewport: HTMLElement,
  virtualList: HTMLElement | null
): number {
  if (!virtualList) return 0
  return Math.max(
    0,
    scrollViewport.scrollTop +
      virtualList.getBoundingClientRect().top -
      scrollViewport.getBoundingClientRect().top
  )
}
