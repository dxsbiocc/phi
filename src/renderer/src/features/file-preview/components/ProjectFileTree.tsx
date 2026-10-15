import { Box, InputAdornment, TextField } from '@mui/material'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PhiIcons } from '../../../icons'
import type { DirectoryListing } from '../../../types'
import {
  fileTreeVirtualWindow,
  normalizedFileTreeVirtualRowHeight,
  type FileTreeVirtualItem,
  type FileTreeVirtualViewport
} from '../../../lib/fileTreeVirtualization'
import {
  fileTreeRevealScrollCorrection,
  fileTreeRevealPaths,
  shouldAutoRevealTreePath,
  shouldRestoreRememberedTreeScroll
} from '../lib/fileTreeReveal'
import {
  fileNameFromPath,
  flattenDirectoryRows,
  type DirectoryLoadState,
  type FileTreeRowDescriptor
} from '../lib/fileTreeRows'
import { useFileTreeActions } from '../hooks/useFileTreeActions'
import {
  fileTreeParentPath,
  fileTreePathInSubtree,
  type FileTreeActions
} from '../lib/fileTreeActions'
import { FileTreeActionMenu } from './FileTreeActionMenu'
import { FileTreeRootRow } from './FileTreeRootRow'
import { FileTreeRow } from './FileTreeRow'
import { FileTreeEmptyRow, FileTreeErrorRow, FileTreeTruncatedRow } from './FileTreeStatusRows'

const SearchIcon = PhiIcons.action.search

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

type FileTreeVirtualRowItem = FileTreeVirtualItem & { row: FileTreeRowDescriptor }

type ProjectFileTreeProps = {
  rootPath: string
  activePath: string
  onOpenFile: (path: string) => void
  fileActions?: FileTreeActions
  onSelectDirectory?: (path: string) => void
  onDropLocalPaths?: (paths: string[], destinationPath: string) => void
  onListDirectory: (path: string) => Promise<DirectoryListing>
  initialListing?: DirectoryListing
  genericDirectoryIcons?: boolean
  revealPath?: string
  searchPlaceholder?: string
  stateKey?: string
  variant?: 'sidebar' | 'standalone'
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
  fileActions,
  onSelectDirectory,
  onDropLocalPaths,
  onListDirectory,
  initialListing,
  genericDirectoryIcons = false,
  revealPath,
  searchPlaceholder = '筛选文件...',
  stateKey,
  variant = 'sidebar'
}: ProjectFileTreeProps): React.JSX.Element {
  const treeStateKey = stateKey ?? `${variant}:${rootPath}`
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
  const directoryVersions = useRef(new Map<string, number>())
  const treeScope = `${treeStateKey}\0${rootPath}`
  const currentTreeScope = useRef(treeScope)
  useEffect(() => {
    currentTreeScope.current = treeScope
  }, [treeScope])
  const isStandalone = variant === 'standalone'
  const revealPaths = useMemo(
    () => (revealPath ? fileTreeRevealPaths(rootPath, revealPath) : []),
    [revealPath, rootPath]
  )
  const revealTarget = revealPaths.at(-1) ?? ''

  useEffect(() => {
    if (!onDropLocalPaths || typeof window.api.onInputFilesDropped !== 'function') return undefined
    return window.api.onInputFilesDropped((paths, target) => {
      if (target.kind !== 'remote-file-tree' || !target.path || paths.length === 0) return
      onDropLocalPaths(paths, target.path)
    })
  }, [onDropLocalPaths])

  useEffect(() => {
    if (revealPaths.length === 0) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setQuery('')
      setExpandedPaths((current) => {
        if (revealPaths.every((path) => current.has(path))) return current
        return new Set([...current, ...revealPaths])
      })
    })
    return () => {
      cancelled = true
    }
  }, [revealPaths])

  useEffect(() => {
    rememberTreeState(treeStateKey, {
      expandedPaths: new Set(expandedPaths),
      query,
      scrollTop: rememberedTreeStates.get(treeStateKey)?.scrollTop ?? savedScrollTopRef.current
    })
  }, [expandedPaths, query, treeStateKey])

  const loadDirectory = useCallback(
    (path: string): void => {
      const version = (directoryVersions.current.get(path) ?? 0) + 1
      directoryVersions.current.set(path, version)
      const scope = treeScope
      void onListDirectory(path)
        .then((listing) => {
          if (currentTreeScope.current !== scope || directoryVersions.current.get(path) !== version)
            return
          setDirectories((prev) => ({ ...prev, [path]: { status: 'ready', listing } }))
        })
        .catch((error) => {
          if (currentTreeScope.current !== scope || directoryVersions.current.get(path) !== version)
            return
          setDirectories((prev) => ({
            ...prev,
            [path]: {
              status: 'error',
              message: error instanceof Error ? error.message : '无法读取目录'
            }
          }))
        })
    },
    [onListDirectory, treeScope]
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

  const actions = useFileTreeActions({
    scope: treeStateKey,
    rootPath,
    fileActions,
    onOpenEntry: (entry) => {
      if (entry.kind === 'file') onOpenFile(entry.path)
      else {
        onSelectDirectory?.(entry.path)
        if (!expandedPaths.has(entry.path)) toggleDirectory(entry.path)
      }
    },
    onMutation: (entry) => {
      const parent = fileTreeParentPath(entry.path)
      for (const [path, version] of directoryVersions.current) {
        if (path === parent || fileTreePathInSubtree(path, entry.path))
          directoryVersions.current.set(path, version + 1)
      }
      setExpandedPaths(
        (current) =>
          new Set([...current].filter((path) => !fileTreePathInSubtree(path, entry.path)))
      )
      setDirectories((current) => ({
        ...Object.fromEntries(
          Object.entries(current).filter(([path]) => !fileTreePathInSubtree(path, entry.path))
        ),
        [parent]: { status: 'loading' }
      }))
      if (parent !== rootPath) loadDirectory(parent)
    }
  })

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

  const revealLayoutKey = useMemo(
    () => flatRows.map((row) => `${row.id}:${virtualRowHeights[row.id] ?? 32}`).join('\0'),
    [flatRows, virtualRowHeights]
  )
  const lastAutoRevealRef = useRef({ target: '', layoutKey: '' })
  useEffect(() => {
    if (!revealTarget) {
      lastAutoRevealRef.current = { target: '', layoutKey: '' }
      return
    }
    if (
      !scrollContainer ||
      !shouldAutoRevealTreePath(
        revealTarget,
        lastAutoRevealRef.current.target,
        revealLayoutKey,
        lastAutoRevealRef.current.layoutKey
      )
    ) {
      return
    }
    let nextScrollTop: number
    if (revealTarget === rootPath) {
      nextScrollTop = 0
    } else {
      const rowIndex = flatRows.findIndex(
        (row) => row.kind === 'entry' && row.entry.path === revealTarget
      )
      if (rowIndex < 0) return
      const precedingHeight = flatRows.slice(0, rowIndex).reduce((height, row) => {
        return height + (virtualRowHeights[row.id] ?? 32)
      }, 34)
      nextScrollTop = Math.max(
        0,
        precedingHeight - Math.max(0, (scrollContainer.clientHeight - 32) / 2)
      )
    }
    let correctionFrame: number | undefined
    const frame = window.requestAnimationFrame(() => {
      scrollContainer.scrollTop = nextScrollTop
      updateVirtualViewport(scrollContainer)
      let attempts = 0
      const correctFromRenderedRow = (): void => {
        const target = [
          ...scrollContainer.querySelectorAll<HTMLElement>('[data-phi-file-path]')
        ].find((element) => element.dataset.phiFilePath === revealTarget)
        if (!target && attempts < 2) {
          attempts += 1
          correctionFrame = window.requestAnimationFrame(correctFromRenderedRow)
          return
        }
        if (target) {
          const containerRect = scrollContainer.getBoundingClientRect()
          const targetRect = target.getBoundingClientRect()
          const correction = fileTreeRevealScrollCorrection({
            containerTop: containerRect.top,
            containerHeight: containerRect.height,
            targetTop: targetRect.top,
            targetHeight: targetRect.height
          })
          if (Math.abs(correction) > 1) scrollContainer.scrollTop += correction
          updateVirtualViewport(scrollContainer)
        }
        restoredScrollRef.current = true
        lastAutoRevealRef.current = { target: revealTarget, layoutKey: revealLayoutKey }
      }
      correctionFrame = window.requestAnimationFrame(correctFromRenderedRow)
    })
    return () => {
      window.cancelAnimationFrame(frame)
      if (correctionFrame !== undefined) window.cancelAnimationFrame(correctionFrame)
    }
  }, [
    flatRows,
    revealLayoutKey,
    revealTarget,
    rootPath,
    scrollContainer,
    updateVirtualViewport,
    virtualRowHeights
  ])

  useEffect(() => {
    if (
      !scrollContainer ||
      !shouldRestoreRememberedTreeScroll(revealTarget, restoredScrollRef.current)
    ) {
      return undefined
    }
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
  }, [directories, expandedPaths, revealTarget, scrollContainer, updateVirtualViewport])

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
              isLoading={
                isDirectory &&
                isExpanded &&
                (!directories[entry.path] || directories[entry.path].status === 'loading')
              }
              genericDirectoryIcons={genericDirectoryIcons}
              localDropTargetPath={onDropLocalPaths && isDirectory ? entry.path : undefined}
              onContextMenu={(event) => actions.onContextMenu(entry, event)}
              onKeyDown={(event) => actions.onKeyDown(entry, event)}
              onDownload={
                !isDirectory && entry.path.startsWith('ssh://') && fileActions?.onDownloadFile
                  ? () => actions.onDownload(entry)
                  : undefined
              }
              onClick={() => {
                if (isDirectory) {
                  onSelectDirectory?.(entry.path)
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
    [
      activePath,
      actions,
      directories,
      expandedPaths,
      genericDirectoryIcons,
      fileActions,
      onOpenFile,
      onDropLocalPaths,
      onSelectDirectory,
      toggleDirectory
    ]
  )

  const rootState = directories[rootPath]
  const rootName = useMemo(() => {
    if (rootState?.status === 'ready') return rootState.listing.name
    return fileNameFromPath(rootPath)
  }, [rootPath, rootState])
  const rootDisplayPath = rootState?.status === 'ready' ? rootState.listing.displayPath : rootPath
  const rootActive = activePath === rootPath
  const rootEntry = {
    path: rootPath,
    name: rootName,
    displayPath: rootDisplayPath,
    kind: 'directory' as const
  }

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
          placeholder={searchPlaceholder}
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
        <Box
          onContextMenu={(event) => actions.onContextMenu(rootEntry, event)}
          onKeyDown={(event) => actions.onKeyDown(rootEntry, event)}
        >
          <FileTreeRootRow
            rootPath={rootPath}
            rootName={rootName}
            rootDisplayPath={rootDisplayPath}
            isExpanded={rootExpanded}
            isActive={rootActive}
            isLoading={rootExpanded && (!rootState || rootState.status === 'loading')}
            localDropTargetPath={onDropLocalPaths ? rootPath : undefined}
            onToggle={() => {
              onSelectDirectory?.(rootPath)
              toggleDirectory(rootPath)
            }}
          />
        </Box>
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
      <FileTreeActionMenu {...actions.menuProps} />
    </Box>
  )
}
