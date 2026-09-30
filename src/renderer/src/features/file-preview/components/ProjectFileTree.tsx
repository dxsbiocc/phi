import { Box, InputAdornment, TextField } from '@mui/material'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PhiIcons } from '../../../icons'
import type { DirectoryListing, FileTreeEntry } from '../../../types'
import {
  fileTreeVirtualWindow,
  normalizedFileTreeVirtualRowHeight,
  type FileTreeVirtualItem,
  type FileTreeVirtualViewport
} from '../../../lib/fileTreeVirtualization'
import { FileTreeRootRow } from './FileTreeRootRow'
import { FileTreeRow } from './FileTreeRow'
import {
  FileTreeEmptyRow,
  FileTreeErrorRow,
  FileTreeLoadingRow,
  FileTreeTruncatedRow
} from './FileTreeStatusRows'

const SearchIcon = PhiIcons.action.search

type DirectoryLoadState =
  | { status: 'loading' }
  | { status: 'ready'; listing: DirectoryListing }
  | { status: 'error'; message: string }

type RememberedTreeState = { expandedPaths: Set<string>; query: string; scrollTop: number }
const rememberedTreeStates = new Map<string, RememberedTreeState>()
const MAX_REMEMBERED_TREES = 50

function rememberTreeState(key: string, state: RememberedTreeState): void {
  rememberedTreeStates.delete(key)
  rememberedTreeStates.set(key, state)
  if (rememberedTreeStates.size > MAX_REMEMBERED_TREES) {
    rememberedTreeStates.delete(rememberedTreeStates.keys().next().value!)
  }
}

type ProjectFileTreeProps = {
  rootPath: string
  activePath: string
  onOpenFile: (path: string) => void
  onListDirectory: (path: string) => Promise<DirectoryListing>
  initialListing?: DirectoryListing
  variant?: 'sidebar' | 'standalone'
}

type FileTreeRowDescriptor =
  | { id: string; kind: 'entry'; entry: FileTreeEntry; depth: number }
  | { id: string; kind: 'loading'; path: string }
  | { id: string; kind: 'error'; path: string; message: string }
  | { id: string; kind: 'empty'; path: string; depth: number; isEmpty: boolean }
  | { id: string; kind: 'truncated'; path: string }

type FileTreeVirtualRowItem = FileTreeVirtualItem & { row: FileTreeRowDescriptor }

function fileNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function matchesQuery(entry: FileTreeEntry, normalizedQuery: string): boolean {
  return (
    entry.name.toLowerCase().includes(normalizedQuery) ||
    entry.displayPath.toLowerCase().includes(normalizedQuery)
  )
}

// Flattens the (recursively expandable) directory tree into a single list of
// row descriptors — data, not JSX — so the list can be windowed the same way
// the chat and notebook lists are: only rows near the viewport get rendered,
// with spacer boxes preserving the scrollable height for the rest.
function flattenDirectoryRows(
  path: string,
  depth: number,
  directories: Record<string, DirectoryLoadState>,
  expandedPaths: Set<string>,
  normalizedQuery: string
): FileTreeRowDescriptor[] {
  const state = directories[path]
  if (!state || state.status === 'loading') {
    return [{ id: `${path}-loading`, kind: 'loading', path }]
  }
  if (state.status === 'error') {
    return [{ id: `${path}-error`, kind: 'error', path, message: state.message }]
  }

  const entries = normalizedQuery
    ? state.listing.entries.filter((entry) => matchesQuery(entry, normalizedQuery))
    : state.listing.entries
  if (entries.length === 0) {
    return [
      {
        id: `${path}-empty`,
        kind: 'empty',
        path,
        depth,
        isEmpty: state.listing.entries.length === 0
      }
    ]
  }

  const rows: FileTreeRowDescriptor[] = []
  for (const entry of entries) {
    rows.push({ id: entry.path, kind: 'entry', entry, depth })
    if (entry.kind === 'directory' && expandedPaths.has(entry.path)) {
      rows.push(
        ...flattenDirectoryRows(entry.path, depth + 1, directories, expandedPaths, normalizedQuery)
      )
    }
  }

  if (state.listing.truncated) {
    rows.push({ id: `${path}-truncated`, kind: 'truncated', path })
  }

  return rows
}

function fileTreeListScrollTop(
  scrollViewport: HTMLElement,
  virtualList: HTMLElement | null
): number {
  if (!virtualList) return 0
  const viewportRect = scrollViewport.getBoundingClientRect()
  const listRect = virtualList.getBoundingClientRect()
  return Math.max(0, scrollViewport.scrollTop + listRect.top - viewportRect.top)
}

function FileTreeVirtualRowShell({
  rowId,
  onMeasure,
  children
}: {
  rowId: string
  onMeasure: (rowId: string, element: HTMLDivElement | null) => void
  children: ReactNode
}): ReactNode {
  const onRowRef = useCallback(
    (element: HTMLDivElement | null) => onMeasure(rowId, element),
    [rowId, onMeasure]
  )

  return (
    <Box ref={onRowRef} sx={{ minWidth: 0, maxWidth: '100%' }}>
      {children}
    </Box>
  )
}

export function ProjectFileTree({
  rootPath,
  activePath,
  onOpenFile,
  onListDirectory,
  initialListing,
  variant = 'sidebar'
}: ProjectFileTreeProps): React.JSX.Element {
  const treeStateKey = `${variant}:${rootPath}`
  const [query, setQuery] = useState(() => rememberedTreeStates.get(treeStateKey)?.query ?? '')
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(rememberedTreeStates.get(treeStateKey)?.expandedPaths ?? [rootPath])
  )
  const [savedScrollTop] = useState(() => rememberedTreeStates.get(treeStateKey)?.scrollTop ?? 0)
  const savedScrollTopRef = useRef(savedScrollTop)
  const restoredScrollRef = useRef(savedScrollTop === 0)
  const [directories, setDirectories] = useState<Record<string, DirectoryLoadState>>(() => ({
    [rootPath]:
      initialListing && initialListing.path === rootPath
        ? { status: 'ready', listing: initialListing }
        : { status: 'loading' }
  }))
  const normalizedQuery = query.trim().toLowerCase()
  const isStandalone = variant === 'standalone'

  useEffect(() => {
    rememberTreeState(treeStateKey, {
      expandedPaths: new Set(expandedPaths),
      query,
      scrollTop: rememberedTreeStates.get(treeStateKey)?.scrollTop ?? savedScrollTopRef.current
    })
  }, [expandedPaths, query, treeStateKey])

  const loadDirectory = useCallback(
    (path: string): void => {
      void onListDirectory(path)
        .then((listing) => {
          setDirectories((prev) => ({ ...prev, [path]: { status: 'ready', listing } }))
        })
        .catch((error) => {
          setDirectories((prev) => ({
            ...prev,
            [path]: {
              status: 'error',
              message: error instanceof Error ? error.message : '无法读取目录'
            }
          }))
        })
    },
    [onListDirectory]
  )

  const ensureDirectoryLoaded = useCallback(
    (path: string): void => {
      if (directories[path]) return
      setDirectories((prev) => ({ ...prev, [path]: { status: 'loading' } }))
      loadDirectory(path)
    },
    [directories, loadDirectory]
  )

  useEffect(() => {
    const rootState = directories[rootPath]
    if (rootState && rootState.status !== 'loading') return
    loadDirectory(rootPath)
  }, [directories, loadDirectory, rootPath])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      for (const path of expandedPaths) {
        if (path !== rootPath) ensureDirectoryLoaded(path)
      }
    })
    return () => {
      cancelled = true
    }
  }, [ensureDirectoryLoaded, expandedPaths, rootPath])

  const toggleDirectory = useCallback(
    (path: string): void => {
      const isExpanded = expandedPaths.has(path)
      setExpandedPaths((prev) => {
        const next = new Set(prev)
        if (isExpanded) {
          next.delete(path)
        } else {
          next.add(path)
        }
        return next
      })
      if (!isExpanded) ensureDirectoryLoaded(path)
    },
    [ensureDirectoryLoaded, expandedPaths]
  )

  const rootExpanded = expandedPaths.has(rootPath)
  const flatRows = useMemo(
    () =>
      rootExpanded
        ? flattenDirectoryRows(rootPath, 1, directories, expandedPaths, normalizedQuery)
        : [],
    [directories, expandedPaths, normalizedQuery, rootExpanded, rootPath]
  )
  const virtualItems = useMemo<FileTreeVirtualRowItem[]>(
    () => flatRows.map((row) => ({ id: row.id, row })),
    [flatRows]
  )

  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null)
  const virtualListRef = useRef<HTMLDivElement | null>(null)
  const virtualRowObserversRef = useRef<Map<string, ResizeObserver>>(new Map())
  const [virtualViewport, setVirtualViewport] = useState<FileTreeVirtualViewport>({
    scrollTop: savedScrollTop,
    viewportHeight: 0
  })
  const [virtualRowHeights, setVirtualRowHeights] = useState<Record<string, number>>({})

  const virtualCells = useMemo(
    () => fileTreeVirtualWindow(virtualItems, virtualRowHeights, virtualViewport),
    [virtualItems, virtualRowHeights, virtualViewport]
  )

  const measureVirtualRow = useCallback((rowId: string, element: HTMLDivElement | null): void => {
    const existingObserver = virtualRowObserversRef.current.get(rowId)
    if (existingObserver) {
      existingObserver.disconnect()
      virtualRowObserversRef.current.delete(rowId)
    }
    if (!element) return

    const updateHeight = (): void => {
      const height = normalizedFileTreeVirtualRowHeight(element.getBoundingClientRect().height)
      setVirtualRowHeights((current) =>
        current[rowId] === height ? current : { ...current, [rowId]: height }
      )
    }
    updateHeight()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    virtualRowObserversRef.current.set(rowId, observer)
  }, [])

  useEffect(() => {
    const observers = virtualRowObserversRef.current
    return () => {
      for (const observer of observers.values()) observer.disconnect()
      observers.clear()
    }
  }, [])

  const handleFileTreeContainerRef = useCallback((node: HTMLDivElement | null): void => {
    setScrollContainer(node)
  }, [])

  const updateVirtualViewport = useCallback(
    (node = scrollContainer): void => {
      if (!node) return
      const listTop = fileTreeListScrollTop(node, virtualListRef.current)
      const nextViewport = {
        scrollTop: Math.max(0, node.scrollTop - listTop),
        viewportHeight: node.clientHeight
      }
      setVirtualViewport((current) =>
        current.scrollTop === nextViewport.scrollTop &&
        current.viewportHeight === nextViewport.viewportHeight
          ? current
          : nextViewport
      )
    },
    [scrollContainer]
  )

  const handleFileTreeScroll = useCallback((): void => {
    updateVirtualViewport()
    if (!scrollContainer) return
    const state = rememberedTreeStates.get(treeStateKey)
    if (state) state.scrollTop = scrollContainer.scrollTop
  }, [scrollContainer, treeStateKey, updateVirtualViewport])

  useEffect(() => {
    if (restoredScrollRef.current || !scrollContainer) return undefined
    if (
      [...expandedPaths].some(
        (path) => !directories[path] || directories[path].status === 'loading'
      )
    ) {
      return undefined
    }
    const frame = window.requestAnimationFrame(() => {
      scrollContainer.scrollTop = savedScrollTopRef.current
      updateVirtualViewport(scrollContainer)
      restoredScrollRef.current = true
    })
    return () => window.cancelAnimationFrame(frame)
  }, [directories, expandedPaths, scrollContainer, updateVirtualViewport])

  useEffect(() => {
    if (!scrollContainer || typeof ResizeObserver === 'undefined') return undefined
    updateVirtualViewport(scrollContainer)
    const observer = new ResizeObserver(() => updateVirtualViewport(scrollContainer))
    observer.observe(scrollContainer)
    return () => observer.disconnect()
  }, [scrollContainer, updateVirtualViewport])

  const renderFileTreeRow = useCallback(
    (row: FileTreeRowDescriptor): ReactNode => {
      switch (row.kind) {
        case 'loading':
          return <FileTreeLoadingRow path={row.path} />
        case 'error':
          return <FileTreeErrorRow path={row.path} message={row.message} />
        case 'empty':
          return <FileTreeEmptyRow path={row.path} depth={row.depth} isEmpty={row.isEmpty} />
        case 'truncated':
          return <FileTreeTruncatedRow path={row.path} />
        case 'entry': {
          const { entry, depth } = row
          const isDirectory = entry.kind === 'directory'
          const isExpanded = expandedPaths.has(entry.path)
          const isActive = entry.path === activePath
          return (
            <FileTreeRow
              entry={entry}
              depth={depth}
              isExpanded={isExpanded}
              isActive={isActive}
              onClick={() => {
                if (isDirectory) {
                  toggleDirectory(entry.path)
                } else {
                  onOpenFile(entry.path)
                }
              }}
            />
          )
        }
      }
    },
    [activePath, expandedPaths, onOpenFile, toggleDirectory]
  )

  const rootState = directories[rootPath]
  const rootName = useMemo(() => {
    if (rootState?.status === 'ready') return rootState.listing.name
    return fileNameFromPath(rootPath)
  }, [rootPath, rootState])
  const rootDisplayPath = rootState?.status === 'ready' ? rootState.listing.displayPath : rootPath
  const rootActive = activePath === rootPath

  return (
    <Box
      aria-label="项目目录树"
      sx={{
        height: '100%',
        width: '100%',
        minHeight: 0,
        minWidth: 0,
        maxWidth: isStandalone ? '100%' : '42%',
        flex: isStandalone ? '1 1 auto' : '0 0 clamp(240px, 30%, 320px)',
        overflow: 'hidden',
        borderLeft: isStandalone ? 0 : 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: isStandalone ? 1 : 0
      }}
    >
      <Box sx={{ px: 1.5, pt: 1.25, pb: 1 }}>
        <TextField
          size="small"
          fullWidth
          placeholder="筛选文件..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" color="action" />
                </InputAdornment>
              )
            }
          }}
        />
      </Box>
      <Box
        ref={handleFileTreeContainerRef}
        onScroll={handleFileTreeScroll}
        sx={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto', px: 0.75, pb: 0.75 }}
      >
        <FileTreeRootRow
          rootPath={rootPath}
          rootName={rootName}
          rootDisplayPath={rootDisplayPath}
          isExpanded={rootExpanded}
          isActive={rootActive}
          onToggle={() => toggleDirectory(rootPath)}
        />
        <Box ref={virtualListRef}>
          {virtualCells.beforeHeight > 0 ? (
            <Box aria-hidden="true" sx={{ height: virtualCells.beforeHeight }} />
          ) : null}
          {virtualCells.items.map(({ item }) => (
            <FileTreeVirtualRowShell
              key={item.row.id}
              rowId={item.row.id}
              onMeasure={measureVirtualRow}
            >
              {renderFileTreeRow(item.row)}
            </FileTreeVirtualRowShell>
          ))}
          {virtualCells.afterHeight > 0 ? (
            <Box aria-hidden="true" sx={{ height: virtualCells.afterHeight }} />
          ) : null}
        </Box>
      </Box>
    </Box>
  )
}
