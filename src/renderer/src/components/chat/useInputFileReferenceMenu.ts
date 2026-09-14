import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import {
  filterInputFileReferenceCandidates,
  findActiveInputFileReference,
  formatInputFileReferenceTarget,
  inputFileReferenceDirectoryPath,
  inputFileReferenceLeafQuery,
  replaceInputReferenceRange
} from '../../lib/inputReferences'
import type { DirectoryListing, FileTreeEntry } from '../../types'
import type { InputFileReferenceMenuState } from './InputFileReferenceMenu'

type UseInputFileReferenceMenuOptions = {
  input: string
  cwd: string
  onListInputDirectory?: (path: string) => Promise<DirectoryListing>
  onInsertReference: (value: string, cursor: number) => void
}

type UseInputFileReferenceMenuResult = {
  menuState: InputFileReferenceMenuState | null
  highlightedIndex: number
  onHighlight: (index: number) => void
  onInputChanged: (inputElement: HTMLInputElement | HTMLTextAreaElement | null) => void
  onInputCursorChanged: (inputElement: HTMLInputElement | HTMLTextAreaElement | null) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => boolean
  onSelect: (entry: FileTreeEntry) => void
}

export function useInputFileReferenceMenu({
  input,
  cwd,
  onListInputDirectory,
  onInsertReference
}: UseInputFileReferenceMenuOptions): UseInputFileReferenceMenuResult {
  const [inputCursor, setInputCursor] = useState(() => input.length)
  const [dismissedReferenceKey, setDismissedReferenceKey] = useState<string | null>(null)
  const [loadedMenuState, setLoadedMenuState] = useState<InputFileReferenceMenuState | null>(null)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const effectiveInputCursor = Math.min(inputCursor, input.length)
  const activeQuery = useMemo(
    () => findActiveInputFileReference(input, effectiveInputCursor),
    [effectiveInputCursor, input]
  )
  const activeKey = activeQuery
    ? `${activeQuery.start}:${activeQuery.end}:${activeQuery.query}`
    : null
  const visibleQuery = activeKey && activeKey !== dismissedReferenceKey ? activeQuery : null
  const directoryPath = visibleQuery
    ? inputFileReferenceDirectoryPath(cwd, visibleQuery.query)
    : null
  const leafQuery = visibleQuery ? inputFileReferenceLeafQuery(visibleQuery.query) : ''
  const menuState = useMemo<InputFileReferenceMenuState | null>(() => {
    if (!visibleQuery || !directoryPath || !onListInputDirectory) return null
    if (
      loadedMenuState?.query === visibleQuery.query &&
      loadedMenuState.directoryPath === directoryPath
    ) {
      return loadedMenuState
    }
    return {
      status: 'loading',
      query: visibleQuery.query,
      directoryPath
    }
  }, [directoryPath, loadedMenuState, onListInputDirectory, visibleQuery])

  useEffect(() => {
    if (!visibleQuery || !directoryPath || !onListInputDirectory) {
      return undefined
    }

    let cancelled = false
    const query = visibleQuery.query

    void onListInputDirectory(directoryPath)
      .then((listing) => {
        if (cancelled) return
        setLoadedMenuState({
          status: 'ready',
          query,
          directoryPath,
          entries: filterInputFileReferenceCandidates(listing.entries, leafQuery)
        })
      })
      .catch((error) => {
        if (cancelled) return
        setLoadedMenuState({
          status: 'error',
          query,
          directoryPath,
          message: error instanceof Error ? error.message : '无法读取目录'
        })
      })

    return () => {
      cancelled = true
    }
  }, [directoryPath, leafQuery, onListInputDirectory, visibleQuery])

  const updateInputCursor = useCallback(
    (inputElement: HTMLInputElement | HTMLTextAreaElement | null): void => {
      setInputCursor(inputElement?.selectionStart ?? input.length)
    },
    [input.length]
  )

  const handleInputChanged = useCallback(
    (inputElement: HTMLInputElement | HTMLTextAreaElement | null): void => {
      setDismissedReferenceKey(null)
      setHighlightedIndex(0)
      updateInputCursor(inputElement)
    },
    [updateInputCursor]
  )

  const selectEntry = useCallback(
    (entry: FileTreeEntry): void => {
      if (!activeQuery) return

      const replacement = replaceInputReferenceRange(
        input,
        activeQuery,
        formatInputFileReferenceTarget(entry)
      )
      setLoadedMenuState(null)
      setDismissedReferenceKey(null)
      setHighlightedIndex(0)
      setInputCursor(replacement.cursor)
      onInsertReference(replacement.value, replacement.cursor)
    },
    [activeQuery, input, onInsertReference]
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): boolean => {
      if (event.nativeEvent.isComposing) return false
      if (!visibleQuery || !menuState) return false

      const entries = menuState.status === 'ready' ? menuState.entries : []

      if (event.key === 'Escape') {
        event.preventDefault()
        if (activeKey) {
          setDismissedReferenceKey(activeKey)
        }
        setLoadedMenuState(null)
        return true
      }

      if (entries.length === 0) return false

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlightedIndex((index) => (index + 1) % entries.length)
        return true
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlightedIndex((index) => (index - 1 + entries.length) % entries.length)
        return true
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const selectedEntry = entries[Math.min(highlightedIndex, entries.length - 1)]
        if (selectedEntry) {
          selectEntry(selectedEntry)
        }
        return true
      }

      return false
    },
    [activeKey, highlightedIndex, menuState, selectEntry, visibleQuery]
  )

  return {
    menuState,
    highlightedIndex,
    onHighlight: setHighlightedIndex,
    onInputChanged: handleInputChanged,
    onInputCursorChanged: updateInputCursor,
    onKeyDown: handleKeyDown,
    onSelect: selectEntry
  }
}
