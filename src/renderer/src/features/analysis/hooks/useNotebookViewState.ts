import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  notebookViewAnchor,
  notebookViewScrollTop,
  notebookViewStateKey,
  notebookVirtualListScrollTop,
  rememberNotebookViewState,
  type NotebookViewState,
  type NotebookViewStateStore
} from '../lib/notebookViewState'

const emptyViewState: NotebookViewState = {
  scrollTop: 0,
  viewportHeight: 0,
  rowHeights: {},
  anchor: null
}

type KeyedViewState = { key: string | null; value: NotebookViewState }

export function useNotebookViewState({
  store: externalStore,
  scope,
  path,
  ready,
  cells,
  scrollViewportRef,
  virtualListRef
}: {
  store?: NotebookViewStateStore
  scope: string
  path: string | null
  ready: boolean
  cells: ReadonlyArray<{ id: string }>
  scrollViewportRef: RefObject<HTMLDivElement | null>
  virtualListRef: RefObject<HTMLDivElement | null>
}): {
  virtualViewport: { scrollTop: number; viewportHeight: number }
  virtualRowHeights: Record<string, number>
  recordRowHeight: (cellId: string, height: number) => void
  captureViewState: () => void
} {
  const [localStore] = useState<NotebookViewStateStore>(() => new Map())
  const store = externalStore ?? localStore
  const key = notebookViewStateKey(scope, path)
  const cached = (key && store.get(key)) || emptyViewState
  const [renderState, setRenderState] = useState<KeyedViewState>(() => ({ key, value: cached }))
  const latestStateRef = useRef(renderState)
  const restoredKeyRef = useRef<string | null>(null)
  const value = renderState.key === key ? renderState.value : cached

  const captureViewState = useCallback((): void => {
    const viewport = scrollViewportRef.current
    // During an open, the DOM may still contain the previous file or a loading message.
    if (!key || !ready || !viewport || restoredKeyRef.current !== key) return
    const current =
      latestStateRef.current.key === key
        ? latestStateRef.current.value
        : (store.get(key) ?? emptyViewState)
    const listTop = notebookVirtualListScrollTop(viewport, virtualListRef.current)
    const scrollTop = viewport.scrollTop - listTop
    const next: NotebookViewState = {
      ...current,
      scrollTop: Math.max(0, scrollTop),
      viewportHeight: viewport.clientHeight,
      anchor: notebookViewAnchor(cells, current.rowHeights, scrollTop)
    }
    if (
      current.scrollTop === next.scrollTop &&
      current.viewportHeight === next.viewportHeight &&
      current.anchor?.cellId === next.anchor?.cellId &&
      current.anchor?.offset === next.anchor?.offset
    )
      return
    latestStateRef.current = { key, value: next }
    rememberNotebookViewState(store, key, next)
    setRenderState(latestStateRef.current)
  }, [cells, key, ready, scrollViewportRef, store, virtualListRef])

  const recordRowHeight = useCallback(
    (cellId: string, height: number): void => {
      if (!key || !ready) return
      const current =
        latestStateRef.current.key === key
          ? latestStateRef.current.value
          : (store.get(key) ?? emptyViewState)
      if (current.rowHeights[cellId] === height) return
      const next = { ...current, rowHeights: { ...current.rowHeights, [cellId]: height } }
      latestStateRef.current = { key, value: next }
      rememberNotebookViewState(store, key, next)
      setRenderState(latestStateRef.current)
    },
    [key, ready, store]
  )

  useLayoutEffect(() => {
    if (!ready) {
      restoredKeyRef.current = null
      return
    }
    const viewport = scrollViewportRef.current
    if (!key || !ready || !viewport || restoredKeyRef.current === key) return
    const current = latestStateRef.current.key === key ? latestStateRef.current.value : cached
    const listTop = notebookVirtualListScrollTop(viewport, virtualListRef.current)
    const top = current.anchor
      ? listTop + notebookViewScrollTop(current, cells, current.rowHeights)
      : current.scrollTop
    viewport.scrollTop = Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight))
    restoredKeyRef.current = key
    captureViewState()
  }, [cached, captureViewState, cells, key, ready, scrollViewportRef, virtualListRef])

  useLayoutEffect(() => {
    return () => {
      // Capture scroll events immediately, then flush that snapshot on unmount.
      // Reading the DOM here could instead save a new file's clamped position.
      if (key && latestStateRef.current.key === key && restoredKeyRef.current === key) {
        rememberNotebookViewState(store, key, latestStateRef.current.value)
      }
    }
  }, [key, store])

  return {
    virtualViewport: value,
    virtualRowHeights: value.rowHeights,
    recordRowHeight,
    captureViewState
  }
}
